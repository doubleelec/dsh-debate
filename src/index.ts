/**
 * dsh-debate — Host 半区(原生包)。
 *
 * 两条线:
 * 1. webServer JSON 路由 /dsh-debate/api/*:面板建单(start,带 sessionId+hint)后
 *    host 直接以后台任务跑完全程(open→round×N→synthesize),不再经过输入框触发语;
 *    state 轮询取实况,stop 中止。
 * 2. model 工具 debate_open/round/synthesize/run:兼容入口(模型手动触发时用,
 *    exec.agent 即 parent);主链路不用它们。
 *
 * v0.3:host 直驱(parent 取自 ctx.agents.get(sessionId),agentOptions 锁定辩手模型)。
 */
import type { Context } from 'cordis'

/** 最小 Agent 面:runDebateLoop 需要 parent 身份 + 会话事件读取 + 进度镜像。 */
export interface ParentAgent {
  readonly session: {
    readonly id: string
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly { type: string; data?: unknown }[]
    events?: (fromSeq?: number) => readonly { type: string; data?: unknown }[]
    surface?: unknown
    /** 会话日志直接追加(对话区直播用:直接进 surface,不经过 inbox,不唤醒模型)。 */
    append?: (type: string, data: unknown, opts?: unknown) => unknown
  }
  [key: string]: unknown
}
/** 最小内容块面:文本块提取所需子集。 */
export interface TextContentBlock {
  readonly type: string
  readonly text?: unknown
  [key: string]: unknown
}
import type { DebateConfig, DebateMap, DebateRound, DebateStatus, TranscriptEntry } from './debate'
import { DEFAULT_CONFIG, classifyQuestion, extractSessionContext, buildBuilderPrompt, buildBuilderRoundPrompt, buildChallengerPrompt, buildSynthesizerPrompt, renderTranscript, toDebateRound, roundConverged, isSaturated, slimHandoff } from './debate'
import { findLens, type LensTemplate } from './lenses'
import { renderLivePage } from './live'

/** 请求面(结构子集,镜像 explorer)。 */
export interface DebateHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/** 响应面(结构子集,镜像 explorer)。 */
export interface DebateHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** cordis Context 增强:webServer 路由注册 + tools 注册 + subagents + workflowEngine。 */
declare module 'cordis' {
  interface Context {
    webServer: {
      register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: DebateHttpRequest, res: DebateHttpResponse) => void | Promise<void> }): () => void
    }
  }
}

/** 一场辩论单。 */
interface DebateSession {
  id: string
  config: DebateConfig
  status: DebateStatus
  /** 已完成的交锋轮数(-1=未开题,0=已开题未交锋,>=1=交锋轮)。 */
  round: number
  transcript: TranscriptEntry[]
  map: DebateMap | null
  /** 制图原文(v0.2:结构化解析前原样返回,自然进会话)。 */
  mapText: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  /** 是否镜像到 parent 对话区(真实会话才 append;自建 parent 没有对话区,只进面板)。 */
  mirrorToChat: boolean
  /** 当前进度(秒级直播:点开始立刻有,每方开写/写完都更新,面板 2s 轮询展示)。 */
  progress: string
  /** 已镜像进对话区的条数(可观测:mirror 失败也不静默)。 */
  mirrorCount: number
  /** 最近一次镜像失败原因(成功时为 null)。 */
  mirrorError: string | null
  /** 实际使用的 parent 会话 id(面板传来的 sid 或兜底选的活体会话,自建 parent 时为 null)。 */
  parentSid: string | null
  /** 停机原因(convergence=共识,saturation=饱和,maxRounds=跑满,manual=手动跳制图;null=未停)。 */
  stopReason: 'convergence' | 'saturation' | 'maxRounds' | 'manual' | null
  /** 每轮判定的解析输入(agree/answer/hasNewInfo)——停机理由可审计,不只给结论(ADR-0014)。 */
  rounds: DebateRound[]
  /** 实际驱动方式(resident=常驻交棒,oneShot=一次性起辩回退)。 */
  mode: 'resident' | 'oneShot'
  /** 常驻建对失败原因(成功回退时也记,便于面板/探针看清为什么没走常驻)。 */
  residentError: string | null
  /**
   * 实时流:正在写的各方当前 turn 流式累计文本(key=role),面板 2s 轮询即见打字机效果。
   * turn 落 transcript 即清对应项;synthesizer 走 one-shot 无流,只有进度文案。
   * kind=text 是 assistant 文本增量;kind=tools 是工具心跳(读文件阶段文本还没出来时)。
   */
  streaming: Record<string, { round: number; kind: 'text' | 'tools'; text: string }>
}

/**
 * 把一步结果镜像进对话区(真实 parent 会话才 append)。
 * 直接 session.append('user/message', …, { surfaceOp: 'append' }):
 * 对话区即时可见,但只是日志追加,不进 inbox、不开 turn、不唤醒模型——纯直播,不干扰。
 * assistant/message 在空闲会话里写不进去(invariant 要求 open turn/step),所以用 user/message。
 * 文本带 ⚔ 辩论 前缀,问题提取时会被过滤,不污染后续提问。
 * 成功/失败都记数,不静默(面板可观测 mirrorCount/mirrorError)。
 */
function mirror(parent: ParentAgent, session: DebateSession, text: string): void {
  if (!session.mirrorToChat) return
  try {
    const append = parent.session.append
    if (typeof append !== 'function') {
      session.mirrorError = 'no-append'
      return
    }
    append.call(parent.session, 'user/message', {
      id: `debate-mirror-${session.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.mirrorCount += 1
    session.mirrorError = null
  } catch (e) {
    session.mirrorError = e instanceof Error ? e.message : String(e)
  }
}

/** 秒级进度(只写内存,面板 2s 轮询即见,不用等模型)。 */
function setProgress(session: DebateSession, progress: string): void {
  session.progress = progress
  session.updatedAt = Date.now()
}

/** @internal 内存单表(供单元测试调整),不构成公开 API。 */
export const sessions = new Map<string, DebateSession>()
let seq = 0

function newId(): string {
  seq += 1
  return `debate-${Date.now().toString(36)}-${seq}`
}

async function readJsonBody(req: DebateHttpRequest): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function writeJson(res: DebateHttpResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(value))
}

/** 校验面板传来的配置(v0.2:只收三模型+轮数+裁判,问题/题型/lens/背景执行时自动)。 */
export function normalizeConfig(body: Record<string, unknown>): { config: DebateConfig } | { error: string } {
  const str = (v: unknown, fb: string): string => (typeof v === 'string' && v.trim() !== '' ? v : fb)
  const route = (v: unknown, fb: { provider: string; model: string }): { provider: string; model: string } => {
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return { provider: str(o.provider, fb.provider), model: str(o.model, fb.model) }
    }
    return { ...fb }
  }
  const maxRoundsRaw = Number(body.maxRounds ?? DEFAULT_CONFIG.maxRounds)
  const maxRounds = Number.isFinite(maxRoundsRaw) ? Math.min(10, Math.max(1, Math.floor(maxRoundsRaw))) : DEFAULT_CONFIG.maxRounds
  // 裁判已从 interface 移除(ADR-0002:默认关且无实现,留着就是死配置);面板也不传。
  // targetCwd:评审别家工程时填(空=沿用发起会话 cwd);建单即校验存在性,fail fast。
  const targetCwd = typeof body.targetCwd === 'string' ? body.targetCwd.trim() : ''
  const cfg: DebateConfig = {
    builder: route(body.builder, DEFAULT_CONFIG.builder),
    challenger: route(body.challenger, DEFAULT_CONFIG.challenger),
    synthesizer: route(body.synthesizer, DEFAULT_CONFIG.synthesizer),
    maxRounds,
    ...(targetCwd !== '' ? { targetCwd } : {}),
  }
  return { config: cfg }
}

/**
 * 执行时自动判断:从 parent 会话提炼问题/题型/lens/背景。
 * hint 为触发语里模型转述的用户意图(可空);hint 为空则取最近一条 user 消息当问题。
 */
export function resolveAuto(events: { type: string; data?: unknown }[], hint: string): NonNullable<DebateConfig['auto']> {
  const question = hint.trim() !== '' ? hint.trim() : lastUserText(events)
  const { questionType, lenses } = classifyQuestion(question)
  const context = extractSessionContext(events)
  return { question, questionType, lenses, context }
}

/** 取最近一条 user 消息文本(触发语/镜像除外,新旧前缀都过滤)。 */
function lastUserText(events: { type: string; data?: unknown }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type !== 'user/message') continue
    const t = looseText(ev.data).trim()
    if (t === '' || /debate_(open|round|synthesize|run)|辩论单|⚔ 辩论|辩论开题|交锋第|成果地图/.test(t)) continue
    return t
  }
  return ''
}

/** 结构化防御的消息文本提取(与 debate.ts 内 extractSessionContext 同源,host 侧轻量拷贝)。 */
function looseText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return ''
  const m = data as Record<string, unknown>
  const cand = m.message ?? m.content ?? m.text ?? m.body
  if (typeof cand === 'string') return cand
  if (Array.isArray(cand)) {
    return cand
      .filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  }
  if (cand !== undefined) return looseText(cand)
  return ''
}

/** live Agent 注册表最小面:host 直驱时按 sessionId 取 parent,取不到则自建。 */
export interface AgentsLike {
  get(id: string): unknown
  list(): Array<{ session?: { id: string } }>
  create(options: {
    sessionId: string
    parentAgent?: unknown
    meta?: { cwd?: string; parentSession?: string; isSeeded?: boolean; origin?: 'subagent'; delegationDepth?: number; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    signal?: AbortSignal
    setup?: (agentCtx: any, agent?: any) => void | Promise<void>
  }): Promise<{ agent: unknown; dispose(): Promise<void> }>
}

/** 常驻辩手 live 面(resident_debater):followup 交棒 + whenIdle 等 turn + 读自有事件。 */
export interface ResidentAgent {
  readonly session: {
    readonly id: string
    seq?: number
    snapshotEvents?: (...args: any[]) => readonly any[]
    events?: (...args: any[]) => readonly any[]
  }
  followup(message: any): void
  whenIdle(): Promise<void>
  cancel?: (...args: any[]) => void
  status?: unknown
  ctx?: unknown
  [key: string]: unknown
}

/** 常驻辩手对:整场存活,host 在两者之间交棒(handoff)。 */
export interface ResidentPair {
  builder: ResidentAgent
  challenger: ResidentAgent
  dispose(): Promise<void>
}

/** preset 注册表最小面:自建 parent 时挂默认 preset(照抄 webhook 样板),子 agent 继承满血工具集。 */
export interface AgentPresetsLike {
  defaultId?: string
  mount(agentCtx: unknown, id: string): Promise<unknown>
  composeFrom?: (agentCtx: unknown, parentCtx: unknown) => string | undefined
  composedPreset?: (agentCtx: unknown) => string | undefined
}

/** 常驻辩手创建时 setup 内的最小 agentCtx 面( composition-only,不 drive)。 */
export interface ResidentSetupCtx {
  get(name: string): any
  systemPrompt: {
    section(s: { name: string; order: number; text: string }): unknown
    context(c: { name: string; order: number; text: string }): unknown
    getSectionOrder(name: string): number
    getContextOrder(name: string): number
  }
  tools: {
    restrict(filter: { allow?: string[]; deny?: string[] }): unknown
  }
}

/** 每场辩论的中止器(stop 路由 abort,后台任务退出)。 */
const controllers = new Map<string, AbortController>()

/**
 * 自建满血 parent(照抄 webhook 样板):meta.agentPreset + setup 里 mount 默认 preset。
 * 不挂 preset 的 parent 落在空 global 层,子 agent 继承下来只有 debate_* 四个工具。
 * cwd 继承发起会话的工作区(子 agent 再继承它,读得到用户的文件);
 * 发起会话无 cwd 才回落进程目录。主链路与 debug-child-tools 探针共用,行为一致。
 */
export async function createFullParent(
  ctx: Context,
  agents: AgentsLike,
  sessionId: string,
  route: { provider: string; model: string },
  signal: AbortSignal,
  inheritCwd?: string,
): Promise<{ agent: ParentAgent; dispose(): Promise<void>; presetId: string | null }> {
  const get = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
  const presets = get('agentPresets') as AgentPresetsLike | undefined
  const presetId = presets?.defaultId ?? null
  const handle = await agents.create({
    sessionId,
    meta: {
      cwd: inheritCwd !== undefined && inheritCwd !== '' ? inheritCwd : process.cwd(),
      ...(presetId !== null && presetId !== '' ? { agentPreset: presetId } : {}),
    },
    agentOptions: { provider: route.provider, model: route.model },
    signal,
    ...(presets && presetId !== null && presetId !== ''
      ? {
          setup: async (agentCtx: unknown) => {
            await presets.mount(agentCtx, presetId)
          },
        }
      : {}),
  })
  return { agent: handle.agent as ParentAgent, dispose: handle.dispose, presetId }
}

/** 读 parent 会话事件(host 直驱与工具共用,工具内闭包委托到这里)。 */
export function readParentEvents(parent: ParentAgent): { type: string; data?: unknown }[] {
  try {
    // 真实会话面是 snapshotEvents(fromSeq?,toSeqExclusive?),旧 events 接口已无。
    const snap = parent.session.snapshotEvents?.(0)
    if (Array.isArray(snap)) return snap as { type: string; data?: unknown }[]
    const legacy = parent.session.events?.(0)
    if (Array.isArray(legacy)) return legacy as { type: string; data?: unknown }[]
  } catch {
    // 会话不可读时退化为空
  }
  return []
}

/** 标记失败并抛错(host 直驱与工具共用)。 */
export function failSession(session: DebateSession, err: unknown): never {
  session.status = 'failed'
  session.error = err instanceof Error ? err.message : String(err)
  session.updatedAt = Date.now()
  throw err
}

/**
 * host 直驱后台任务:start 路由建单后调用,不阻塞 HTTP 响应。
 * parent 优先取自 ctx.agents.get(sid)(面板从 input.right 的 sessionId 传来);
 * sid 对不上则兜底取第一个活体会话(面板没传 sid 时对话区仍能直播);
 * 都没有则 host 自建一次性 parent,不再等会话 id。
 * 全程 stepOpen→stepRound×N→stepSynthesize,进度落 transcript + progress,
 * 每方写完即 mirror 进对话区 + 面板轮询展示(秒级直播,不用等整步)。
 */
export async function runHostDebate(
  ctx: Context,
  session: DebateSession,
  hint: string,
  sid: string,
  signal: AbortSignal,
  givenParent?: ParentAgent,
): Promise<void> {
  const done = (): void => {
    controllers.delete(session.id)
    session.updatedAt = Date.now()
  }
  let owned: { dispose(): Promise<void> } | null = null
  let pair: ResidentPair | null = null
  try {
    const get = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
    const subagents = get('subagents') as SubagentsLike | undefined
    if (!subagents) throw new Error('subagents service unavailable')
    const agents = get('agents') as AgentsLike | undefined
    // E(聊天开局):工具入口直接给 parent(天生就是发起会话,cwd 全自动),跳过 sid/自建全套。
    let parent = givenParent
    if ((!parent || !parent.session) && sid !== '') {
      parent = (agents?.get(sid) ?? undefined) as ParentAgent | undefined
    }
    if ((!parent || !parent.session) && agents) {
      // sid 对不上(面板没传/传错)则兜底取第一个活体会话,对话区仍能直播。
      try {
        const live = agents.list() ?? []
        const first = live.find((a) => (a as ParentAgent)?.session?.id) as ParentAgent | undefined
        if (first?.session) parent = first
      } catch { /* 兜底失败则走自建 */ }
    }
    if ((!parent || !parent.session) && agents) {
      // host 自建满血 parent(preset 继承链:子 agent 拿到 standard 全套工具)。
      // 注意这是无活体会话时的兜底:发起会话的 parent 拿不到才走这里,
      // 此时没有发起会话 cwd 可继承,用进程目录(探针/无会话场景)。
      try {
        const full = await createFullParent(ctx, agents, `debate-parent-${session.id}`, session.config.synthesizer, signal, session.config.targetCwd)
        owned = { dispose: full.dispose }
        parent = full.agent
      } catch (e) {
        throw new Error(`no-live-agent:自建 parent 失败(${e instanceof Error ? e.message : String(e)}),先在 3090 打开一个会话再重试`)
      }
    }
    if (!parent || !parent.session) throw new Error('no-live-agent:面板没拿到当前会话 id,换个有输入框的会话重试')
    // 真实会话(parent 来自 agents.get/兜底活体)才镜像进度到对话区;自建 parent 没有对话区可写。
    session.mirrorToChat = owned === null
    session.parentSid = owned === null ? (parent.session.id as string) : null
    if (signal.aborted) throw new Error('aborted')
    session.config.auto = resolveAuto(readParentEvents(parent), hint)
    const auto = session.config.auto
    if (auto.question === '') throw new Error('empty-question:输入框没有问题,先写下要辩的问题再点开始')
    // 秒级直播:建单→自动判断完成即有进度,不用等第一个模型输出。
    setProgress(session, `已启动:「${auto.question}」(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model},共 ${session.config.maxRounds} 轮)。建构者开写中…`)
    mirror(parent, session, `⚔ 辩论开始:「${auto.question}」(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model},共 ${session.config.maxRounds} 轮,制图 ${session.config.synthesizer.model})。开题马上到,进度同步见面板。`)
    const live = {
      onStart: (who: string): void => {
        setProgress(session, who)
      },
      onSide: (who: string, title: string, text: string): void => {
        setProgress(session, `${title}已出,面板/对话区同步`)
        mirror(parent, session, `## ${title}\n\n${text}`)
      },
    }
    // S1:常驻优先——建对成功则开题+交锋全走交棒(handoff),记忆留在常驻会话里;
    // 建对失败(agents 不可用/setup 被拒)才回退一次性起辩,transcript 为空时才可退。
    if (agents) {
      try {
        setProgress(session, `常驻辩手建对中(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model})…`)
        pair = await createResidentPair(ctx, agents, parent, session.id, session.config.builder, session.config.challenger, signal, session.config.targetCwd)
        session.mode = 'resident'
        session.residentError = null
      } catch (e) {
        if (signal.aborted) throw new Error('aborted')
        // 回退必须可观测:面板/探针要能回答"为什么这局不是常驻"。
        session.residentError = (e as Error)?.message ?? String(e)
        session.mode = 'oneShot'
        setProgress(session, `常驻建对失败(${session.residentError}),回退一次性起辩…`)
        mirror(parent, session, `⚠ 常驻辩手建对失败,已回退一次性起辩。原因:${session.residentError}`)
        pair = null
      }
    } else {
      session.mode = 'oneShot'
      session.residentError = 'agents service unavailable'
    }
    try {
      if (pair) {
        await stepOpenResident(pair, session, signal, {
          onStart: () => live.onStart('建构者与挑战者互盲开写中(常驻)…'),
          onSide: (role, text) => live.onSide(role,
            role === 'builder' ? '建构者开题(先到先播·常驻)' : '挑战者开题(互盲·常驻)',
            `问题:${auto.question}\n题型:${auto.questionType}\n\n${text}`),
        })
      } else {
        await stepOpen(subagents, parent, session, signal, {
          onStart: () => live.onStart('建构者与挑战者互盲开写中…'),
          onSide: (role, text) => live.onSide(role,
            role === 'builder' ? '建构者开题(先到先播)' : '挑战者开题(互盲)',
            `问题:${auto.question}\n题型:${auto.questionType}\n\n${text}`),
        })
      }
    } finally {
      // 开题即失败且走的是常驻:成对回收,不留孤儿会话。
      if (pair && session.round < 0) {
        try { await pair.dispose() } catch { /* 回收失败不掩盖开题错 */ }
        pair = null
      }
    }
    setProgress(session, `开题完成,进入第 1/${session.config.maxRounds} 轮交锋`)
    let stop: 'convergence' | 'saturation' | 'maxRounds' | null = null
    for (let r = 1; r <= session.config.maxRounds; r++) {
      if (signal.aborted) throw new Error('aborted')
      // 常驻已建对则整场走交棒;中途失败即停,不中途切一次性(记忆形状不同,混跑污染 transcript)。
      let bOut: string
      let cOut: string
      let relayChars = 0
      if (pair) {
        const out = await stepRoundResident(pair, session, signal, {
          onStart: (role) => live.onStart(role === 'builder' ? `第 ${r} 轮建构方开写中(常驻)…` : `第 ${r} 轮挑战方开写中(常驻)…`),
          onSide: (role, text) => live.onSide(role,
            role === 'builder' ? `交锋第 ${r}/${session.config.maxRounds} 轮·建构方(常驻)` : `交锋第 ${r}/${session.config.maxRounds} 轮·挑战方(常驻)`,
            text),
        })
        bOut = out.builderOut
        cOut = out.challengerOut
        relayChars = out.builderRelayChars
      } else {
        const out = await stepRound(subagents, parent, session, signal, {
          onStart: (role) => live.onStart(role === 'builder' ? `第 ${r} 轮建构方开写中…` : `第 ${r} 轮挑战方开写中…`),
          onSide: (role, text) => live.onSide(role,
            role === 'builder' ? `交锋第 ${r}/${session.config.maxRounds} 轮·建构方(先到先播)` : `交锋第 ${r}/${session.config.maxRounds} 轮·挑战方`,
            text),
        })
        bOut = out.builderOut
        cOut = out.challengerOut
        relayChars = out.builderRelayChars
      }
      // 停机判定:解析只做一次,判定与审计共用同一份输入(recordRoundAndJudge,ADR-0014)。
      const verdict = recordRoundAndJudge(session, r, bOut, cOut, relayChars)
      if (verdict === 'convergence') {
        stop = 'convergence'
        setProgress(session, `第 ${r}/${session.config.maxRounds} 轮双方认可同一答案,提前停机`)
        mirror(parent, session, `✅ 共识收敛:第 ${r} 轮双方 agree 同一答案,交锋提前结束,进入制图。`)
        break
      }
      if (verdict === 'saturation') {
        stop = 'saturation'
        setProgress(session, `第 ${r}/${session.config.maxRounds} 轮无新增信息,覆盖饱和停机`)
        mirror(parent, session, `🛑 覆盖饱和:第 ${r} 轮无新增视角/缺口/状态变化,交锋提前结束,进入制图。`)
        break
      }
      if (r < session.config.maxRounds) setProgress(session, `第 ${r}/${session.config.maxRounds} 轮完成,进入第 ${r + 1} 轮`)
      if (r === session.config.maxRounds) stop = 'maxRounds'
    }
    session.stopReason = stop ?? 'maxRounds'
    setProgress(session, '交锋完成,制图员写地图中…')
    await stepSynthesize(subagents, parent, session, signal, {
      onStart: () => live.onStart('制图员写地图中…'),
      onSide: (_role, text) => live.onSide('synthesizer', '成果地图', text),
    })
    setProgress(session, '已完成')
    session.status = 'done'
    done()
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === 'aborted')) {
      session.status = 'stopped'
      session.error = null
    } else {
      session.status = 'failed'
      session.error = err instanceof Error ? err.message : String(err)
    }
    done()
  } finally {
    if (pair) {
      try { await pair.dispose() } catch { /* 常驻回收失败不影响结果 */ }
    }
    if (owned) {
      try { await owned.dispose() } catch { /* 自建 parent 回收失败不影响结果 */ }
    }
  }
}
export interface SubagentsLike {
  start(provider: string, req: {
    parent: ParentAgent
    prompt: TextContentBlock[]
    label?: string
    signal: AbortSignal
    agentOptions?: { provider?: string; model?: string }
    toolFilter?: { allow?: string[]; deny?: string[] }
  }): Promise<{ result: Promise<{ output: TextContentBlock[]; stopReason: string }>; dispose(): Promise<void> }>
}

/** 文本块提取:子 agent 输出的 assistant 文本。 */
function textOf(blocks: TextContentBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 辩论子 agent 工具笼(只读论证员):
 * - 留:read/glob/grep(读文件找证据)、web_fetch/web_search(联网查证)。
 * - 禁:ask_user_question(会等人点, one-shot 直接 hang,轮次 -1 卡死的元凶);
 *   write/edit(辩论只读不写);pwsh(不给执行,只留读);
 *   subagent_fork/workflow/ralph(防套娃);
 *   present/create_goal/todo 系列(论证用不上,防跑偏)。
 * 注意:deny 只能点全局名。`subagent` 是 preset 层的 scope-local 名,
 * restrict 明确拒绝(scope-local names fail),实测 unknown 抛错,所以不列;
 * fork 的全局名就是 subagent_fork,可以禁。
 * 新版本(0.2.0)全局工具表里已无 ralph:deny 列它会 unknown 抛错整场毙掉,故不列(防套娃靠 subagent_fork + workflow 已够)。
 * 制图员同笼(只读实录,不参辩,工具更少也够)。
 */
const DEBATE_TOOL_DENY = [
  'ask_user_question',
  'write', 'edit',
  'pwsh',
  'subagent_fork', 'workflow',
  'present', 'create_goal', 'update_goal', 'get_goal',
  'todo_write',
  'interrupt_agent', 'send_message', 'list_agents',
  'job_kill',
  'exit_plan_mode',
]

/** 一次性子 agent 单步超时:6 分钟。子 agent hang 住(等人点/大海捞针)时直接失败,不无限卡轮次。 */
const STEP_TIMEOUT_MS = 6 * 60 * 1000

/** 常驻辩手轮次卡死阈值:多久没有任何新事件才算卡住(干活久不算错,见 turnVerdict)。 */
export const STEP_STALL_MS = 4 * 60 * 1000

/** 常驻辩手单轮硬顶:再久也不能无限等(有进度也砍),兜住"永不 hang"。 */
export const STEP_HARD_CAP_MS = 20 * 60 * 1000

/** 常驻辩手轮次进度采样间隔。 */
export const PROGRESS_POLL_MS = 10 * 1000

/**
 * 常驻轮次是否该中断(纯判定,便于单测):
 * idleMs=距上次有新事件的时长,totalMs=本 turn 总时长。
 * 先看硬顶(有进度也砍),再看卡死(无新事件)。两者都够不到才继续等。
 */
export function turnVerdict(idleMs: number, totalMs: number): 'ok' | 'stalled' | 'hard-cap' {
  if (totalMs >= STEP_HARD_CAP_MS) return 'hard-cap'
  if (idleMs >= STEP_STALL_MS) return 'stalled'
  return 'ok'
}

/** 起一次 one-shot 子 agent 并取文本(带工具笼 + 单步超时 + 实报原因)。 */
export async function askSubagent(
  subagents: SubagentsLike,
  parent: ParentAgent,
  sessionId: string,
  role: 'builder' | 'challenger' | 'synthesizer',
  prompt: string,
  route: { provider: string; model: string },
  signal: AbortSignal,
): Promise<string> {
  const timeout = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => {
    timeoutFired = true
    timeout.abort(new Error(`subagent-${role}:timeout(${STEP_TIMEOUT_MS / 60000}min)`))
  }, STEP_TIMEOUT_MS)
  const onAbort = (): void => timeout.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    const run = await subagents.start('spawn', {
      parent,
      prompt: [{ type: 'text', text: prompt } as TextContentBlock],
      label: `debate-${sessionId}-${role}`,
      signal: timeout.signal,
      agentOptions: { provider: route.provider, model: route.model },
      toolFilter: { deny: DEBATE_TOOL_DENY },
    })
    try {
      let result: { output: TextContentBlock[]; stopReason: string }
      try {
        result = await run.result
      } catch (e) {
        // 基础设施fault(result Promise 本身 reject):外层停了归 stopped,超时归超时。
        if (signal.aborted) throw new Error('aborted')
        if (timeoutFired) throw new Error(`subagent-${role}:timeout(${STEP_TIMEOUT_MS / 60000}min,写超时,已中止)`)
        throw e instanceof Error ? e : new Error(String(e))
      }
      if (result.stopReason === 'completed') return textOf(result.output)
      // stopReason 非 completed:先分清是谁杀的,再实报(之前一律报 aborted,超时原因被吞)。
      if (signal.aborted) throw new Error('aborted')
      if (timeoutFired) throw new Error(`subagent-${role}:timeout(${STEP_TIMEOUT_MS / 60000}min,写超时,已中止)`)
      throw new Error(`subagent-${role}:${result.stopReason}`)
    } finally {
      await run.dispose()
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 辩论子 agent 工具笼(只读论证员):
 * - 留:read/glob/grep(读文件找证据)、web_fetch/web_search(联网查证)。
 * - 禁:ask_user_question(会等人点, one-shot 直接 hang,轮次 -1 卡死的元凶);
 *   write/edit(辩论只读不写);pwsh(不给执行,只留读);
 *   subagent_fork/workflow/ralph(防套娃);
 *   present/create_goal/todo 系列(论证用不上,防跑偏)。
 * 注意:deny 只能点全局名。`subagent` 是 preset 层的 scope-local 名,
 * restrict 明确拒绝(scope-local names fail),实测 unknown 抛错,所以不列;
 * fork 的全局名就是 subagent_fork,可以禁。
 */
/**
 * 子 agent 固定 delegation 声明(照抄 dsh-subagent/child-agent 的 SUBAGENT_DELEGATION_CONTEXT):
 * runtime-context 贡献,不是 system section,所以部署的 system prompt 在 parent/child 间保持一致。
 */
const SUBAGENT_DELEGATION_CONTEXT =
  'You are a delegated subagent: your permission scope was fixed when you were started and cannot be ' +
  'widened from inside this session — operations that require approval are rejected automatically. ' +
  'When the task needs access beyond that scope, do not retry the denied operation; state the ' +
  'limitation in your reply so the delegating agent can handle it.'

/** 读常驻辩手自有事件(owned suffix 由调用方按长度切)。 */
export function readResidentEvents(agent: ResidentAgent): { type: string; data?: any }[] {
  try {
    const snap = (agent.session as any).snapshotEvents?.(0)
    if (Array.isArray(snap)) return snap as { type: string; data?: any }[]
    const legacy = (agent.session as any).events?.(0)
    if (Array.isArray(legacy)) return legacy as { type: string; data?: any }[]
  } catch {
    // 会话不可读时退化为空,调用方报 empty-output
  }
  return []
}

/**
 * 工具心跳(heartbeat):turn 内 assistant 文本还没出来(读文件/调工具阶段)时,
 * 给面板看的活物。只读事件 type,不碰 data(形状未知也不崩):
 * 后缀里找含 tool 子串的事件 type,取最后一种,形如"🔧 tool/call ×3"。
 * 无 tool 事件返回 null(调用方显示"思考中…"还是空由面板定)。
 */
export function heartbeatOf(suffix: readonly { type: string; data?: any }[]): string | null {
  let lastTool = ''
  let count = 0
  for (const e of suffix) {
    if (typeof e.type === 'string' && e.type.toLowerCase().includes('tool')) {
      if (e.type === lastTool) count++
      else {
        lastTool = e.type
        count = 1
      }
    }
  }
  if (lastTool === '') return null
  return `🔧 ${lastTool} ×${count}`
}

/** 文本块数组取文本(交棒结论提取用,与 textOf 同源但容忍 any)。 */
function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

/** durable stream 记录取文本(照抄 dsh-llm joinAssistantStreamText 的两条分支)。 */
function streamText(stream: unknown): string {
  if (!Array.isArray(stream)) return ''
  const parts: string[] = []
  for (const r of stream) {
    if (r === null || typeof r !== 'object') continue
    const rec = r as Record<string, any>
    if (rec.type === 'text-chunks' && Array.isArray(rec.texts)) parts.push(rec.texts.join(''))
    else if (rec.type === 'chunk' && rec.chunk !== null && typeof rec.chunk === 'object' && rec.chunk.type === 'text-delta' && typeof rec.chunk.text === 'string') parts.push(rec.chunk.text)
  }
  return parts.join('')
}

/**
 * 交棒结论(handoff_conclusion)提取:最后非空助手消息,没有才回落流式累计。
 * 照抄 dsh-subagent AssistantOutputFold 的选择规则(与 stopReason 无关)。
 */
export function extractHandoffConclusion(events: readonly { type: string; data?: any }[]): string | null {
  let message: unknown
  const partial: string[] = []
  for (const e of events) {
    if (e.type === 'assistant/message') {
      const content = (e.data as any)?.message?.content
      // 只有带文本的才成为候选:空 content 的 usage-only 消息不替换 earlier 输出(照抄 AssistantOutputFold)。
      if (Array.isArray(content) && content.length > 0 && blocksText(content) !== '') message = content
      const s = (e.data as any)?.stream
      const t = streamText(s)
      if (t !== '') partial.push(t)
    } else if (e.type === 'assistant/attempt') {
      const t = streamText((e.data as any)?.stream)
      if (t !== '') partial.push(t)
    }
  }
  if (message !== undefined) {
    const t = blocksText(message)
    return t !== '' ? t : partial.join('') !== '' ? partial.join('') : null
  }
  const text = partial.join('')
  return text !== '' ? text : null
}

/** 本 epoch 最后一个 turn/end 的终端原因,映射到 subagent  seam 词汇(completed/max-tokens/aborted/refusal/error)。 */
export function epochStopReason(events: readonly { type: string; data?: any }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'turn/end') {
      const kind = (e.data as any)?.reason?.kind as string | undefined
      switch (kind) {
        case 'completed': return 'completed'
        case 'max-tokens': return 'max-tokens'
        case 'aborted': return 'aborted'
        case 'blocked': return 'refusal'
        default: return 'error'
      }
    }
  }
  return 'error'
}

/**
 * 本 epoch 最后一个 turn/end 的终端细节(QAS-2:中断原因实报,不吞成 error)。
 * error 取 reason.error.message(provider/模型侧真因),aborted 取 signal.reason,其余为空。
 */
export function epochStopDetail(events: readonly { type: string; data?: any }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== 'turn/end') continue
    const reason = (e.data as any)?.reason
    if (reason === null || typeof reason !== 'object') return ''
    const err = (reason as any).error
    if (err !== undefined && err !== null) {
      if (typeof err === 'string') return err
      const m = (err as any).message
      if (typeof m === 'string' && m !== '') return m
      const c = (err as any).code
      if (typeof c === 'string' && c !== '') return c
    }
    const r = (reason as any).reason
    if (typeof r === 'string' && r !== '') return r
    if (r instanceof Error && r.message !== '') return r.message
    return ''
  }
  return ''
}

/**
 * 常驻辩手建对:整场存活的两个可续聊子会话(各绑自己的模型路由)。
 * composition 照抄子 agent 链路:先 join parent 的 preset 生成(优先 composeFrom,保证与 parent 同代),
 * 再挂 delegation 声明,最后 tools.restrict(deny 笼)。persona 不另挂:角色定义随每轮 prompt 进 inbox,
 * 常驻记忆里自然有。
 * parentAgent 活体拥有:parent 销毁时连带回收;meta 只带 cwd + preset,不写 lineage(保持根会话形状)。
 */
export async function createResidentPair(
  ctx: Context,
  agents: AgentsLike,
  parent: ParentAgent,
  debateId: string,
  builderRoute: { provider: string; model: string },
  challengerRoute: { provider: string; model: string },
  signal: AbortSignal,
  targetCwd?: string,
): Promise<ResidentPair> {
  const get = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
  const presets = get('agentPresets') as AgentPresetsLike | undefined
  const presetId = presets?.defaultId ?? null
  const parentCtx = (parent as any)?.ctx as unknown | undefined
  // cwd 三级:显式目标工作区(评审别家工程) > 发起会话 cwd > 进程目录。
  const inheritCwd = (parent as any)?.session?.header?.cwd as string | undefined
  const cwd = targetCwd !== undefined && targetCwd !== '' ? targetCwd
    : inheritCwd !== undefined && inheritCwd !== '' ? inheritCwd : process.cwd()
  const setupFor = (): ((agentCtx: any) => void | Promise<void>) => async (agentCtx: any) => {
    // 1) join parent 生成(同步 bind,无 roster 读取失败模式);parentCtx 拿不到才回落 mount 默认。
    try {
      if (presets?.composeFrom && parentCtx) {
        presets.composeFrom(agentCtx, parentCtx)
      } else if (presets && presetId !== null && presetId !== '') {
        await presets.mount(agentCtx, presetId)
      }
    } catch { /* join 失败不拦创建:prompt 仍可跑,工具集回落全局 */ }
    // 2) delegation 声明。
    try {
      agentCtx.systemPrompt.context({
        name: 'subagent:delegation',
        order: agentCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: SUBAGENT_DELEGATION_CONTEXT,
      })
    } catch { /* 上下文挂不上不拦创建 */ }
    // 3) 工具笼(整场有效,创建时 restrict 一次)。
    try {
      agentCtx.tools.restrict({ deny: DEBATE_TOOL_DENY })
    } catch { /* restrict 失败时抛给创建事务回滚 */ throw new Error('resident-restrict-failed') }
  }
  const mkOne = async (role: 'builder' | 'challenger', route: { provider: string; model: string }): Promise<{ agent: ResidentAgent; dispose: () => Promise<void> }> => {
    const handle = await agents.create({
      sessionId: `debate-${debateId}-${role}`,
      parentAgent: parent,
      meta: {
        cwd,
        ...(presetId !== null && presetId !== '' ? { agentPreset: presetId } : {}),
      },
      agentOptions: { provider: route.provider, model: route.model },
      signal,
      setup: setupFor(),
    })
    return { agent: handle.agent as ResidentAgent, dispose: handle.dispose }
  }
  let bHandle: { agent: ResidentAgent; dispose: () => Promise<void> } | null = null
  try {
    bHandle = await mkOne('builder', builderRoute)
    const cHandle = await mkOne('challenger', challengerRoute)
    const b = bHandle.agent
    const bDispose = bHandle.dispose
    const cDispose = cHandle.dispose
    const challenger = cHandle.agent
    return {
      builder: b,
      challenger,
      dispose: async () => {
        // host 持有创建句柄的 dispose 能力:停轮→等静→unregister→拆 session→unwind scope 由 registry 负责。
        const results = await Promise.allSettled([bDispose(), cDispose()])
        const first = results.find((r) => r.status === 'rejected')
        if (first?.status === 'rejected') throw first.reason
      },
    }
  } catch (e) {
    // 建对半路失败:已出的那方 dispose 回收,不留孤儿会话。
    if (bHandle) {
      try { await bHandle.dispose() } catch { /* 回收失败不掩盖原错 */ }
    } else {
      try { (null as unknown as ResidentAgent | null)?.cancel?.({ kind: 'user' }) } catch { /* 忽略 */ }
    }
    throw e
  }
}

/** 常驻轮次尝试次数上限:provider 偶发内部错误时重投同一轮(同会话,记忆形状不变)。 */
export const RESIDENT_TURN_ATTEMPTS = 3

/**
 * provider/模型侧 error 才值得重投;超时、卡死、空输出、拒绝、外层中止重投只会再卡一次。
 * 判据是 driveResidentTurn 抛出的错误前缀(resident-<role>:error...)。
 */
export function isRetriableTurnError(message: string): boolean {
  return /^resident-(builder|challenger):error(\(|$)/.test(message)
}

/**
 * 交棒(handoff):把一段 prompt 投进常驻辩手 inbox,等 turn 跑完,取交棒结论。
 * provider 偶发 error 时重投(至多 RESIDENT_TURN_ATTEMPTS 次);超时/中止如实上抛。
 */
export async function driveResidentTurn(
  agent: ResidentAgent,
  prompt: string,
  role: 'builder' | 'challenger',
  signal: AbortSignal,
  onStream?: (preview: { kind: 'text' | 'tools'; text: string }) => void,
  opts?: { pollMs?: number },
): Promise<string> {
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= RESIDENT_TURN_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error('aborted')
    try {
      return await driveResidentOnce(agent, prompt, role, signal, onStream, opts?.pollMs)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (!isRetriableTurnError(lastErr.message) || signal.aborted) throw lastErr
      if (attempt === RESIDENT_TURN_ATTEMPTS) {
        throw new Error(`${lastErr.message.replace(/\)$/, '')},重投 ${RESIDENT_TURN_ATTEMPTS} 次仍失败)`)
      }
    }
  }
  throw lastErr ?? new Error(`resident-${role}:unknown`)
}

/** 单次交棒尝试:followup → 进度感知等待 → 读自有后缀 → 校验终止原因与交棒结论。 */
async function driveResidentOnce(
  agent: ResidentAgent,
  prompt: string,
  role: 'builder' | 'challenger',
  signal: AbortSignal,
  onStream?: (preview: { kind: 'text' | 'tools'; text: string }) => void,
  pollMs: number = PROGRESS_POLL_MS,
): Promise<string> {
  if (signal.aborted) throw new Error('aborted')
  const boundary = readResidentEvents(agent).length
  agent.followup({
    id: `debate-handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  })
  const startedAt = Date.now()
  let seen = boundary
  let lastProgressAt = startedAt
  let lastStream = ''
  // 文本优先,工具心跳兜底:读文件阶段 assistant 还没吐字时,面板至少能看到"🔧 tool/call ×3"。
  const publish = (): void => {
    if (!onStream) return
    try {
      const suffix = readResidentEvents(agent).slice(boundary)
      const cur = extractHandoffConclusion(suffix) ?? ''
      if (cur !== '' && cur !== lastStream) {
        lastStream = cur
        onStream({ kind: 'text', text: cur })
        return
      }
      if (cur === '' && lastStream === '') {
        const beat = heartbeatOf(suffix)
        if (beat !== null && beat !== lastBeat) {
          lastBeat = beat
          onStream({ kind: 'tools', text: beat })
        }
      }
    } catch { /* 流发布失败不影响等待 */ }
  }
  let lastBeat = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let onAbort: (() => void) | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearInterval(timer)
        if (onAbort !== null) signal.removeEventListener('abort', onAbort)
        fn()
      }
      // 进度感知超时:干活久不算错,卡住才算。事件计数在长就直接续期。
      // 顺手发布流式累计文本:assistant/attempt 的 stream 增量即打字机数据源(面板 2s 轮询)。
      timer = setInterval(() => {
        const now = Date.now()
        const count = readResidentEvents(agent).length
        publish()
        if (count > seen) {
          seen = count
          lastProgressAt = now
          return
        }
        const verdict = turnVerdict(now - lastProgressAt, now - startedAt)
        if (verdict === 'ok') return
        try { agent.cancel?.({ kind: 'user' }) } catch { /* 忽略 */ }
        const mins = Math.round((verdict === 'stalled' ? now - lastProgressAt : now - startedAt) / 60000)
        const why = verdict === 'stalled' ? `stalled(${mins}min 无新事件,已中止)` : `timeout(${mins}min 硬顶,已中止)`
        done(() => reject(new Error(`resident-${role}:${why}`)))
      }, pollMs)
      onAbort = () => {
        try { agent.cancel?.({ kind: 'user' }) } catch { /* 忽略 */ }
        done(() => reject(new Error('aborted')))
      }
      signal.addEventListener('abort', onAbort, { once: true });
      (async () => {
        try {
          await agent.whenIdle()
          done(() => resolve())
        } catch (e) {
          done(() => reject(e instanceof Error ? e : new Error(String(e))))
        }
      })()
    })
  } finally {
    if (timer !== null) clearInterval(timer)
    if (onAbort !== null) signal.removeEventListener('abort', onAbort)
  }
  if (signal.aborted) throw new Error('aborted')
  // 短 turn 可能在第一个轮询 tick 前就跑完:结束时保底发布一次,调用方至少见过一次预览。
  publish()
  const suffix = readResidentEvents(agent).slice(boundary)
  const stop = epochStopReason(suffix)
  if (stop !== 'completed') {
    if (signal.aborted) throw new Error('aborted')
    const detail = epochStopDetail(suffix)
    throw new Error(`resident-${role}:${stop}${detail !== '' ? `(${detail})` : ''}`)
  }
  const text = extractHandoffConclusion(suffix)
  if (text === null || text.trim() === '') throw new Error(`resident-${role}:empty-output`)
  return text
}

/** 取自动判断(未 resolve 抛错)。 */
function requireAuto(session: DebateSession): NonNullable<DebateConfig['auto']> {
  const auto = session.config.auto
  if (!auto) throw new Error('debate session not resolved: call debate_open first')
  if (auto.question === '') throw new Error('empty-question: no user message found in parent session')
  return auto
}

function pushEntry(session: DebateSession, role: TranscriptEntry['role'], round: number, text: string): void {
  session.transcript.push({ seq: session.transcript.length + 1, role, round, text })
  session.updatedAt = Date.now()
}

function lensObjsOf(session: DebateSession): LensTemplate[] {
  return requireAuto(session).lenses
    .map((id) => findLens(id))
    .filter((l): l is LensTemplate => l !== undefined)
}

/** 直播钩子:每方开写/写完即回调(host 直驱用来秒级播进度+镜像对话区)。 */
export interface StepLive {
  onStart?: (role: 'builder' | 'challenger' | 'synthesizer') => void
  onSide?: (role: 'builder' | 'challenger' | 'synthesizer', text: string) => void
}

/**
 * 第一步:开题(互盲并行)。返回双方开题文本(调用方负责进会话)。
 * 防呆:配置不同模型但双方自报一致 → 抛 model-route-ineffective。
 * 独立结算:一边挂了另一边的内容不丢,错误里带上已出的那方(好定位是模型慢还是工具 hang)。
 */
export async function stepOpen(
  subagents: SubagentsLike,
  parent: ParentAgent,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ builderOpen: string; challengerOpen: string }> {
  const cfg = session.config
  const auto = requireAuto(session)
  const lensObjs = lensObjsOf(session)
  const ctxText = auto.context ?? ''
  live?.onStart?.('builder')
  live?.onStart?.('challenger')
  const runOne = async (role: 'builder' | 'challenger', route: { provider: string; model: string }): Promise<string> => {
    const text = await askSubagent(subagents, parent, session.id, 'builder', buildBuilderPrompt(auto.question, lensObjs, auto.questionType, ctxText), route, signal)
    pushEntry(session, role, 0, text)
    live?.onSide?.(role, text)
    return text
  }
  const settled = await Promise.allSettled([
    runOne('builder', cfg.builder),
    runOne('challenger', cfg.challenger),
  ])
  const [b, c] = settled
  if (b.status === 'rejected' || c.status === 'rejected') {
    const bErr = b.status === 'rejected' ? String((b.reason as Error)?.message ?? b.reason) : null
    const cErr = c.status === 'rejected' ? String((c.reason as Error)?.message ?? c.reason) : null
    throw new Error(`open-failed: builder=${bErr ?? 'ok'}, challenger=${cErr ?? 'ok'}`)
  }
  const builderOpen = b.value
  const challengerOpen = c.value
  session.round = 0
  const echoA = extractModelEcho(builderOpen)
  const echoB = extractModelEcho(challengerOpen)
  if (isRouteIneffective(echoA, echoB, cfg.builder, cfg.challenger)) {
    throw new Error(`model-route-ineffective: both sides report ${echoA}`)
  }
  return { builderOpen, challengerOpen }
}

/**
 * 第一步(常驻):开题(互盲并行)。prompt 构造与 one-shot 完全同形,只是驱动换成交棒。
 * 常驻记忆里自然有角色定义,开题 prompt 即首个 turn 的 inbox 载荷。
 */
export async function stepOpenResident(
  pair: ResidentPair,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ builderOpen: string; challengerOpen: string }> {
  const cfg = session.config
  const auto = requireAuto(session)
  const lensObjs = lensObjsOf(session)
  const ctxText = auto.context ?? ''
  live?.onStart?.('builder')
  live?.onStart?.('challenger')
  const runOne = async (role: 'builder' | 'challenger'): Promise<string> => {
    const agent = role === 'builder' ? pair.builder : pair.challenger
    // 与 stepOpen 同形:双方互盲,都用建构开题 prompt 铺首轮(挑战者的钢人化从第 1 轮开始)。
    // 流发布:结论以 transcript 为准,streaming 只是实时预览;双方都落盘后统一清,
    // 避免先跑完的那方出现"流已清、文未落"的空窗(开题并行,正式文本要等两边都出才落)。
    const text = await driveResidentTurn(agent, buildBuilderPrompt(auto.question, lensObjs, auto.questionType, ctxText), role, signal,
      (p) => { session.streaming[role] = { round: 0, kind: p.kind, text: p.text } })
    pushEntry(session, role, 0, text)
    live?.onSide?.(role, text)
    return text
  }
  const settled = await Promise.allSettled([
    runOne('builder'),
    runOne('challenger'),
  ])
  const [b, c] = settled
  if (b.status === 'rejected' || c.status === 'rejected') {
    const bErr = b.status === 'rejected' ? String((b.reason as Error)?.message ?? b.reason) : null
    const cErr = c.status === 'rejected' ? String((c.reason as Error)?.message ?? c.reason) : null
    throw new Error(`open-failed: builder=${bErr ?? 'ok'}, challenger=${cErr ?? 'ok'}`)
  }
  const builderOpen = b.value
  const challengerOpen = c.value
  session.round = 0
  // 开题流统一清:双方正式文本都已落 transcript,预览使命结束(避免先跑完那方的空窗)。
  delete session.streaming.builder
  delete session.streaming.challenger
  const echoA = extractModelEcho(builderOpen)
  const echoB = extractModelEcho(challengerOpen)
  if (isRouteIneffective(echoA, echoB, cfg.builder, cfg.challenger)) {
    throw new Error(`model-route-ineffective: both sides report ${echoA}`)
  }
  return { builderOpen, challengerOpen }
}

/**
 * 第二步(常驻):交锋一轮(串行 A→B)。prompt 构造与 one-shot 同形(含原有的 builder 侧用挑战 prompt 的形状),
 * 只换驱动:建构先接对方上一段,挑战再接建构本轮。记忆在常驻会话里,交棒载荷只是对方结论。
 */
export async function stepRoundResident(
  pair: ResidentPair,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ round: number; builderOut: string; challengerOut: string; builderRelayChars: number }> {
  const cfg = session.config
  const auto = requireAuto(session)
  const next = session.round + 1
  if (next > cfg.maxRounds) throw new Error(`rounds-exhausted: maxRounds=${cfg.maxRounds}`)
  if (signal.aborted) throw new Error('aborted')
  const ctxText = auto.context ?? ''
  const prevRound = session.round
  const builderPrevRaw = prevRound === 0
    ? lastBy(session, 'builder', 0)
    : lastBy(session, 'challenger', prevRound)
  // 交棒载荷(ADR-0015):对方文本首次进入本方视野传全文,此后跨轮传瘦身;全文留 transcript。
  const brief = prevRound === 0 ? { text: builderPrevRaw, briefChars: builderPrevRaw.length } : slimHandoff(builderPrevRaw)
  const builderPrev = brief.text
  live?.onStart?.('builder')
  const bOut = await driveResidentTurn(pair.builder, buildBuilderRoundPrompt(auto.question, builderPrev, next, cfg.maxRounds, ctxText), 'builder', signal,
    (p) => { session.streaming.builder = { round: next, kind: p.kind, text: p.text } })
  delete session.streaming.builder
  pushEntry(session, 'builder', next, bOut)
  live?.onSide?.('builder', bOut)
  live?.onStart?.('challenger')
  // 同轮内仍传对方全文:挑战者必须能逐条引用原文(否则钢人化复述无从谈起)。
  const cOut = await driveResidentTurn(pair.challenger, buildChallengerPrompt(auto.question, bOut, '', next, cfg.maxRounds, ctxText), 'challenger', signal,
    (p) => { session.streaming.challenger = { round: next, kind: p.kind, text: p.text } })
  delete session.streaming.challenger
  pushEntry(session, 'challenger', next, cOut)
  live?.onSide?.('challenger', cOut)
  session.round = next
  return { round: next, builderOut: bOut, challengerOut: cOut, builderRelayChars: brief.briefChars }
}

/**
 * 记一轮判定输入并给出停机结论(host 直驱与工具分步共用,ADR-0014 判定同源)。
 * 返回 'convergence'/'saturation' 表示应停机;null 表示继续。
 */
export function recordRoundAndJudge(
  session: DebateSession,
  round: number,
  builderOut: string,
  challengerOut: string,
  builderRelayChars = 0,
): 'convergence' | 'saturation' | null {
  const prevCombined = round === 1
    ? [lastBy(session, 'builder', 0), lastBy(session, 'challenger', 0)].join('\n\n')
    : [lastBy(session, 'builder', round - 1), lastBy(session, 'challenger', round - 1)].join('\n\n')
  const record = toDebateRound(round, builderOut, challengerOut, prevCombined, builderRelayChars)
  session.rounds.push(record)
  if (roundConverged(record)) return 'convergence'
  if (isSaturated(session.rounds)) return 'saturation'
  return null
}

/** 取某角色某轮的最后输出。 */
function lastBy(session: DebateSession, role: 'builder' | 'challenger', round: number): string {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const e = session.transcript[i]
    if (e.role === role && e.round === round) return e.text
  }
  return ''
}

/**
 * 第二步:交锋一轮(串行 A→B)。返回双方本轮输出(调用方负责进会话)。
 * 到达 maxRounds 后调用方应转制图,不再调本步。
 */
export async function stepRound(
  subagents: SubagentsLike,
  parent: ParentAgent,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ round: number; builderOut: string; challengerOut: string; builderRelayChars: number }> {
  const cfg = session.config
  const auto = requireAuto(session)
  const next = session.round + 1
  if (next > cfg.maxRounds) throw new Error(`rounds-exhausted: maxRounds=${cfg.maxRounds}`)
  if (signal.aborted) throw new Error('aborted')
  const ctxText = auto.context ?? ''
  const prevRound = session.round
  const builderPrevRaw = prevRound === 0
    ? lastBy(session, 'builder', 0)
    : lastBy(session, 'challenger', prevRound)
  // 与常驻路径同一条交棒规则(ADR-0015):首次全文,此后跨轮瘦身,保证两条驱动方式行为一致。
  const brief = prevRound === 0 ? { text: builderPrevRaw, briefChars: builderPrevRaw.length } : slimHandoff(builderPrevRaw)
  const builderPrev = brief.text
  live?.onStart?.('builder')
  const bOut = await askSubagent(subagents, parent, session.id, 'builder', buildBuilderRoundPrompt(auto.question, builderPrev, next, cfg.maxRounds, ctxText), cfg.builder, signal)
  pushEntry(session, 'builder', next, bOut)
  live?.onSide?.('builder', bOut)
  live?.onStart?.('challenger')
  const cOut = await askSubagent(subagents, parent, session.id, 'challenger', buildChallengerPrompt(auto.question, bOut, '', next, cfg.maxRounds, ctxText), cfg.challenger, signal)
  pushEntry(session, 'challenger', next, cOut)
  live?.onSide?.('challenger', cOut)
  session.round = next
  return { round: next, builderOut: bOut, challengerOut: cOut, builderRelayChars: brief.briefChars }
}

/**
 * 第三步:制图(独立调用,只读实录)。返回制图原文与空地图壳(调用方负责进会话)。
 */
export async function stepSynthesize(
  subagents: SubagentsLike,
  parent: ParentAgent,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ mapText: string; map: DebateMap }> {
  const cfg = session.config
  const auto = requireAuto(session)
  live?.onStart?.('synthesizer')
  const mapText = await askSubagent(subagents, parent, session.id, 'synthesizer', buildSynthesizerPrompt(auto.question, renderTranscript(session.transcript)), cfg.synthesizer, signal)
  pushEntry(session, 'synthesizer', cfg.maxRounds + 1, mapText)
  live?.onSide?.('synthesizer', mapText)
  const map: DebateMap = {
    lenses: lensObjsOf(session).map((l) => ({ name: l.name, claim: '' })),
    arguments: [],
    grounding: [],
    disputes: [],
    gaps: [],
  }
  session.map = map
  session.mapText = mapText
  return { mapText, map }
}

/** 从开题输出里提取 MODEL: 回显行,用于防呆(路由未生效则停)。 */
/**
 * 模型自报回显:MODEL:<provider>/<model> 或 MODEL:unknown(模型按 prompt 如实说不知道)。
 * unknown 是"没信息"不是"相同信息"——防呆只看双方报出具体且相同的回显才判路由失效。
 */
export function extractModelEcho(text: string): string | null {
  const m = text.match(/MODEL:\s*([^\s]+)/)
  return m ? m[1] : null
}

/** 防呆:双方都报出具体回显、回显相同、但配置的路由不同 → 路由没生效。unknown 不参与判定。 */
export function isRouteIneffective(
  echoA: string | null,
  echoB: string | null,
  builder: { provider: string; model: string },
  challenger: { provider: string; model: string },
): boolean {
  if (echoA === null || echoB === null) return false
  if (echoA.toLowerCase() === 'unknown' || echoB.toLowerCase() === 'unknown') return false
  if (echoA !== echoB) return false
  return builder.model !== challenger.model || builder.provider !== challenger.provider
}

/**
 * 跑完整辩论循环(在工具 execute 内调用,parent 为 exec.agent)。
 * 通过 ctx 上的 subagents 起 one-shot 子 agent,agentOptions 锁定模型。
 * v0.2:仅供单测/兼容, panel 链路由 debate_open/challenge/synthesize 三工具分步驱动,
 * 每步结果自然进会话(动态显示),面板照常轮询。
 */
export async function runDebateLoop(
  subagents: SubagentsLike,
  parent: ParentAgent,
  session: DebateSession,
  signal: AbortSignal,
): Promise<DebateMap> {
  await stepOpen(subagents, parent, session, signal)
  const max = session.config.maxRounds
  for (let r = 1; r <= max; r++) {
    if (signal.aborted) throw new Error('aborted')
    await stepRound(subagents, parent, session, signal)
  }
  const { map } = await stepSynthesize(subagents, parent, session, signal)
  return map
}

export default {
  // tools/subagents/agents/agentPresets 必须声明 inject,否则属性读取抛错且注册静默失败(09-24 实测根因)。
  inject: ['webServer', 'tools', 'subagents', 'agents', 'agentPresets'],
  apply(ctx: Context) {
    const routes: Array<{ kind: 'exact' | 'prefix'; path: string; handler: (req: DebateHttpRequest, res: DebateHttpResponse) => void | Promise<void> }> = [
      {
        kind: 'exact',
        path: '/dsh-debate/api/start',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const parsed = normalizeConfig(body)
          if ('error' in parsed) return writeJson(res, { ok: false, error: parsed.error })
          const session: DebateSession = {
            id: newId(),
            config: parsed.config,
            status: 'running',
            round: -1,
            transcript: [],
            map: null,
            mapText: null,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mirrorToChat: false,
            progress: '建单成功,后台启动中…',
            mirrorCount: 0,
            mirrorError: null,
            parentSid: null,
            stopReason: null,
            rounds: [],
            mode: 'oneShot',
            residentError: 'not-attempted',
            streaming: {},
          }
          // targetCwd 存在性 fail fast:用户填错路径不等开题才挂,建单即报。
          // fs 探针用动态 import(宿主 node 直跑;vitest 下 import 失败则跳过校验,覆盖逻辑由单测保证)。
          if (parsed.config.targetCwd) {
            try {
              const fs = await import('node:fs') as unknown as { existsSync(p: string): boolean }
              if (!fs.existsSync(parsed.config.targetCwd)) {
                return writeJson(res, { ok: false, error: `targetCwd 不存在:${parsed.config.targetCwd}` })
              }
            } catch { /* 探针不可用时放行,运行时 cwd 缺失由 agent 侧报错 */ }
          }
          sessions.set(session.id, session)
          // v0.3:建单即后台直驱,不再经过输入框触发语。hint=输入框问题快照,sid=当前会话 id。
          // cwd=面板从 useSessions 读来的会话工作区(host 侧 Web 会话不可见,只能面板传):
          // 最可信,直接定 targetCwd,辩手读得到本工程文件。
          const hint = typeof body.hint === 'string' ? body.hint : ''
          const sid = typeof body.sid === 'string' ? body.sid : ''
          const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
          if (cwd !== '' && !parsed.config.targetCwd) parsed.config.targetCwd = cwd
          const ctl = new AbortController()
          controllers.set(session.id, ctl)
          void runHostDebate(ctx, session, hint, sid, ctl.signal)
          return writeJson(res, { ok: true, id: session.id })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/api/state',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const session = sessions.get(String(body.id ?? ''))
          if (!session) return writeJson(res, { ok: false, error: 'unknown-id' })
          return writeJson(res, {
            ok: true,
            id: session.id,
            status: session.status,
            round: session.round,
            transcript: session.transcript,
            auto: session.config.auto ? {
              question: session.config.auto.question,
              questionType: session.config.auto.questionType,
              lenses: session.config.auto.lenses.length,
              contextChars: session.config.auto.context.length,
              targetCwd: session.config.targetCwd ?? null,
            } : undefined,
            mapText: session.mapText,
            map: session.map,
            error: session.error,
            progress: session.progress,
            mirrorCount: session.mirrorCount,
            mirrorError: session.mirrorError,
            parentSid: session.parentSid,
            stopReason: session.stopReason,
            rounds: session.rounds,
            mode: session.mode,
            residentError: session.residentError,
            streaming: session.streaming,
          })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/api/stop',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const session = sessions.get(String(body.id ?? ''))
          if (!session) return writeJson(res, { ok: false, error: 'unknown-id' })
          // v0.3:先 abort 后台任务,再兜底置 stopped(任务退出时自己会收 controllers)。
          try { controllers.get(session.id)?.abort() } catch { /* 忽略 */ }
          if (session.status === 'running') {
            session.status = 'stopped'
            session.updatedAt = Date.now()
          }
          return writeJson(res, { ok: true, id: session.id, status: session.status })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/live',
        handler: async (req, res) => {
          // 实况页:host 直出独立 HTML,window.open 新窗口打开,不经 React/slot/CSS 缓存。
          // id 从 query 取(?id=xxx);未知 id 也照常出页,页内轮询会报 unknown-id。
          try {
            const raw = typeof req.url === 'string' ? req.url : '/dsh-debate/live'
            const id = new URL(raw, 'http://x').searchParams.get('id') ?? ''
            const html = renderLivePage(id)
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(html)
          } catch {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('bad live page request')
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/api/debug-child-tools',
        handler: async (req, res) => {
          // 真探针:起一个一次性子 agent,让它自己报手里有什么工具。
          // 读注册表只能看到 host 视角,子 agent 的真实工具集以它自己的回答为准。
          // body: { sid } (parent 会话 id;不传则用第一个活体;无活体则自建满血 parent)。
          // 零业务成本:只问工具表,不跑辩论。自建 parent 用完即 dispose。
          let owned: { dispose(): Promise<void> } | null = null
          try {
            const body = await readJsonBody(req)
            const agents = ctx.get('agents') as AgentsLike | undefined
            const subagents = ctx.get('subagents') as SubagentsLike | undefined
            if (!agents || !subagents) return writeJson(res, { ok: false, error: 'agents/subagents unavailable' })
            const sid = typeof body.sid === 'string' ? body.sid : ''
            let parent = (sid !== '' ? agents.get(sid) : undefined) as ParentAgent | undefined
            if (!parent || !(parent as ParentAgent).session) {
              const live = agents.list() ?? []
              parent = live.find((a) => ((a as ParentAgent)?.session?.id)) as ParentAgent | undefined
            }
            let selfBuilt = false
            let presetId: string | null = null
            if (!parent || !parent.session) {
              const full = await createFullParent(ctx, agents, `debate-probe-${Date.now().toString(36)}`, DEFAULT_CONFIG.synthesizer, AbortSignal.timeout(180000))
              owned = { dispose: full.dispose }
              parent = full.agent
              selfBuilt = true
              presetId = full.presetId
            }
            if (!parent || !parent.session) return writeJson(res, { ok: false, error: 'no live parent' })
            const ctl = new AbortController()
            const timer = setTimeout(() => ctl.abort(), 120000)
            try {
              const run = await subagents.start('spawn', {
                parent,
                prompt: [{
                  type: 'text',
                  text: '你是工具盘点员。只做一件事:列出你当前能调用的所有工具名,一行一个,不要解释,不要调用任何工具,不要输出别的。',
                } as TextContentBlock],
                label: 'debate-debug-child-tools',
                signal: ctl.signal,
              })
              try {
                const result = await run.result
                return writeJson(res, {
                  ok: true,
                  parentSid: parent.session.id,
                  selfBuilt,
                  presetId,
                  stopReason: result.stopReason,
                  childTools: textOf(result.output),
                })
              } finally {
                await run.dispose()
              }
            } finally {
              clearTimeout(timer)
            }
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          } finally {
            if (owned) {
              try { await owned.dispose() } catch { /* 探针自建 parent 回收失败不影响结果 */ }
            }
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/api/debug',
        handler: async (_req, res) => {
          // 自检:模型可见的 debate_* 工具是否注册上(curl 即判,不用进 GUI)。
          try {
            const tools = ctx.get('tools') as { schemas?: (scope?: unknown) => Array<{ name?: unknown }> } | undefined
            const all = tools?.schemas?.() ?? []
            const names = all.map((t) => t.name).filter((n): n is string => typeof n === 'string')
            return writeJson(res, { ok: true, tools: names.filter((n) => n.startsWith('debate_')) })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/api/debug-agent',
        handler: async (req, res) => {
          // 自检:host 能否按 sid 拿到活体 parent(零模型成本,不起子 agent)。
          // 不传 sid 则列出所有活体 agent id,供 curl 探针取一个真实 sid 跑全链路。
          // 传 sid 则加报 parent 的 composition(preset/cwd)与该 scope 可见工具数:
          // 子 agent 继承 parent 的 preset 再 restrict 收窄,parent 残则子必残。
          try {
            const body = await readJsonBody(req)
            const agents = ctx.get('agents') as {
              get(id: string): { session?: { id: string; header?: Record<string, unknown> }; ctx?: { get(name: string): unknown } } | undefined
              list(): Array<{ session?: { id: string } }>
            } | undefined
            if (!agents) return writeJson(res, { ok: false, error: 'agents service unavailable' })
            const live = agents.list().map((a) => a.session?.id ?? '?')
            const sid = typeof body.sid === 'string' ? body.sid : ''
            if (sid === '') return writeJson(res, { ok: true, live })
            const parent = agents.get(sid)
            if (!parent?.session) return writeJson(res, { ok: true, live, resolved: false })
            const header = (parent.session.header ?? {}) as Record<string, unknown>
            let scopeTools: string[] | null = null
            let scopeError: string | null = null
            try {
              const tools = parent.ctx?.get('tools') as
                | { schemas?: (scope?: unknown) => Array<{ name?: unknown }> }
                | undefined
              // scope 传 agent 本人(不是 agent.ctx):schemas 按 agent 视角做 chainLayers 解析。
              const all = tools?.schemas?.(parent) ?? []
              scopeTools = all
                .map((t) => t.name)
                .filter((n): n is string => typeof n === 'string')
                .sort()
            } catch (e) {
              scopeError = e instanceof Error ? e.message : String(e)
            }
            return writeJson(res, {
              ok: true,
              live,
              resolved: true,
              preset: header.agentPreset ?? null,
              cwd: header.cwd ?? null,
              delegationDepth: header.delegationDepth ?? null,
              scopeToolCount: scopeTools?.length ?? null,
              scopeTools,
              scopeError,
            })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-debate/api/debug-sessions',
        handler: async (_req, res) => {
          // 自检:内存里所有 debate 会话的状态一览(定位"面板有局、host 无局"的分叉)。
          try {
            const list: Array<Record<string, unknown>> = []
            for (const s of sessions.values()) {
              const streams: Record<string, string> = {}
              for (const k of Object.keys(s.streaming)) {
                const v = s.streaming[k]
                streams[k] = v.kind + ':' + String(v.text.length) + '字'
              }
              list.push({
                id: s.id,
                status: s.status,
                round: s.round,
                tr: s.transcript.length,
                mode: s.mode,
                progress: s.progress,
                error: s.error,
                targetCwd: s.config.targetCwd ?? null,
                createdAt: s.createdAt,
                streaming: streams,
              })
            }
            return writeJson(res, { ok: true, count: list.length, sessions: list })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
    ]
    // 真实 webServer.register 只接受单个 route(数组会被静默塞进前缀表导致路由失效,见 explorer 经验)
    for (const route of routes) ctx.webServer.register(route)

    // model 工具(v0.2 三步分调,每步结果自然进会话动态显示,面板照常轮询):
    // debate_open 建单自动判断+开题 → debate_round 逐轮交锋 → debate_synthesize 制图。
    // debate_run 保留作兼容(一次跑完,供单测与旧触发语)。
    //
    // 注册形态(09-24 实测根因,勿回退):
    // - 必须走 ctx.tools.register(defineTool({...})) 全 DSL:裸对象缺 output.render
    //   必被 register 抛 TypeError,外层 try/catch 会静默吞掉,工具从没注册上;
    // - parameters 用 DSL 写法({ sessionId: { type:'string', required:true } }),
    //   不能套 JSON Schema 的 { type:'object', properties } 壳;
    // - ctx.tools / ctx.subagents 走声明式 inject 读取,不做 as unknown 断言。
    try {
      const tools = ctx.get('tools') as {
        register(def: {
          name: string
          description: string
          parameters: Record<string, unknown>
          output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
          execute: (args: unknown, exec: { agent?: unknown; signal: AbortSignal }) => Promise<unknown>
        }): () => void
      } | undefined
      if (!tools) throw new Error('tools service unavailable')
      const subagents = ctx.get('subagents') as SubagentsLike | undefined
      if (!subagents) throw new Error('subagents service unavailable')
      const textOut = {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      }
      const getSession = (args: { sessionId?: unknown }): DebateSession => {
        const id = args.sessionId
        if (typeof id !== 'string') throw new Error('requires sessionId')
        const session = sessions.get(id)
        if (!session) throw new Error(`unknown debate session: ${id}`)
        return session
      }
      const readEvents = (parent: ParentAgent): { type: string; data?: unknown }[] => readParentEvents(parent)
      const fail = (session: DebateSession, err: unknown): never => failSession(session, err)
      const sidParam = {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '面板建单返回的 id' },
          hint: { type: 'string', description: '可选:用户意图转述(如输入框草稿)。为空则取最近一条 user 消息当问题。' },
        },
        required: ['sessionId'],
      }
      tools.register({
        name: 'debate_open',
        description: '辩论第一步:从当前会话自动提取问题/背景并开题(双方互盲作答)。返回双方开题全文,直接发给用户展示,再调 debate_round 继续。',
        parameters: sidParam,
        output: textOut,
        execute: async (args, exec) => {
          const parent = exec.agent as ParentAgent | undefined
          if (!parent) throw new Error('debate_open requires a calling agent')
          const session = getSession(args as { sessionId?: unknown })
          try {
            const a = (args ?? {}) as { hint?: unknown }
            session.config.auto = resolveAuto(readEvents(parent), typeof a.hint === 'string' ? a.hint : '')
            const { builderOpen, challengerOpen } = await stepOpen(subagents, parent, session, exec.signal)
            session.updatedAt = Date.now()
            return (
              `## 辩论开题\n\n问题:${session.config.auto.question}\n题型:${session.config.auto.questionType}\n\n` +
              `### 建构者开题\n${builderOpen}\n\n### 挑战者开题\n${challengerOpen}\n\n` +
              `(继续调用 debate_round sessionId=${session.id} 进入第 1 轮交锋)`
            )
          } catch (err) {
            fail(session, err)
          }
        },
      })
      tools.register({
        name: 'debate_round',
        description: '辩论第二步:交锋一轮(双方各一次,串行)。返回本轮双方输出,直接发给用户展示;未达最大轮数继续调本工具,达到后调 debate_synthesize 制图。',
        parameters: sidParam,
        output: textOut,
        execute: async (args, exec) => {
          const parent = exec.agent as ParentAgent | undefined
          if (!parent) throw new Error('debate_round requires a calling agent')
          const session = getSession(args as { sessionId?: unknown })
          try {
            const { round, builderOut, challengerOut, builderRelayChars } = await stepRound(subagents, parent, session, exec.signal)
            session.updatedAt = Date.now()
            // 与 host 直驱同一套判定(ADR-0014):工具分步入口不再"跑完就 done 但没说为什么停"。
            const verdict = recordRoundAndJudge(session, round, builderOut, challengerOut, builderRelayChars)
            const more = round < session.config.maxRounds
            let tail: string
            if (verdict === 'convergence') {
              session.stopReason = 'convergence'
              tail = `(双方本轮 agree 同一答案,已满足共识停机,调用 debate_synthesize sessionId=${session.id} 制图)`
            } else if (verdict === 'saturation') {
              session.stopReason = 'saturation'
              tail = `(本轮无新增信息,已满足覆盖饱和停机,调用 debate_synthesize sessionId=${session.id} 制图)`
            } else if (more) {
              tail = `(继续调用 debate_round sessionId=${session.id} 进入下一轮)`
            } else {
              session.stopReason = 'maxRounds'
              tail = `(已达最大轮数,调用 debate_synthesize sessionId=${session.id} 制图)`
            }
            return (
              `## 交锋第 ${round}/${session.config.maxRounds} 轮\n\n### 建构方\n${builderOut}\n\n### 挑战方\n${challengerOut}\n\n` +
              tail
            )
          } catch (err) {
            fail(session, err)
          }
        },
      })
      tools.register({
        name: 'debate_synthesize',
        description: '辩论第三步:制图员只读实录输出五件套成果地图。返回地图全文,直接发给用户展示,辩论结束。',
        parameters: sidParam,
        output: textOut,
        execute: async (args, exec) => {
          const parent = exec.agent as ParentAgent | undefined
          if (!parent) throw new Error('debate_synthesize requires a calling agent')
          const session = getSession(args as { sessionId?: unknown })
          try {
            const { mapText } = await stepSynthesize(subagents, parent, session, exec.signal)
            // 手动跳到制图也要留痕:stopReason=manual(否则 done 却答不出"为什么停")。
            if (session.stopReason === null) session.stopReason = 'manual'
            session.progress = '已完成'
            session.status = 'done'
            session.updatedAt = Date.now()
            return `## 成果地图\n\n${mapText}`
          } catch (err) {
            fail(session, err)
          }
        },
      })
      tools.register({
        name: 'debate_start',
        description: '聊天开局:在当前会话直接开一场辩论(问题/背景自动提取,cwd 自动继承本会话工作区,辩手读得到本工程文件)。后台直驱开题+交锋+制图,返回 debate 会话 id,面板用此 id 轮询看实况。',
        parameters: {
          type: 'object',
          properties: {
            hint: { type: 'string', description: '可选:要辩的问题(如输入框草稿)。为空则取最近一条 user 消息当问题。' },
            maxRounds: { type: 'number', description: '可选:最大交锋轮数(1~10,默认 5)。' },
          },
        },
        output: textOut,
        execute: async (args, exec) => {
          const parent = exec.agent as ParentAgent | undefined
          if (!parent?.session) throw new Error('debate_start requires a calling agent with session')
          const a = (args ?? {}) as Record<string, unknown>
          const parsed = normalizeConfig({ maxRounds: a.maxRounds ?? DEFAULT_CONFIG.maxRounds })
          if ('error' in parsed) throw new Error(parsed.error)
          // cwd 天生正确:常驻对直接继承发起会话 cwd,不走 targetCwd 后门。
          const cwd = (parent.session as unknown as { header?: Record<string, unknown> })?.header?.cwd
          if (typeof cwd === 'string' && cwd !== '') parsed.config.targetCwd = cwd
          const session: DebateSession = {
            id: newId(),
            config: parsed.config,
            status: 'running',
            round: -1,
            transcript: [],
            map: null,
            mapText: null,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mirrorToChat: true,
            progress: '建单成功(聊天开局),后台启动中…',
            mirrorCount: 0,
            mirrorError: null,
            parentSid: parent.session.id as string,
            stopReason: null,
            rounds: [],
            mode: 'oneShot',
            residentError: 'not-attempted',
            streaming: {},
          }
          sessions.set(session.id, session)
          const hint = typeof a.hint === 'string' ? a.hint : ''
          const ctl = new AbortController()
          controllers.set(session.id, ctl)
          const ctxLike = ctx as unknown as Context
          void runHostDebate(ctxLike, session, hint, '', ctl.signal, parent)
          return (
            `⚔ 辩论已开(会话 ${session.id},工作区 ${parsed.config.targetCwd ?? '默认'}):后台直驱中,` +
            `面板输入此 id 跟局,或点面板"在独立实况页打开"。进度与实录会同步进本会话。`
          )
        },
      })
      tools.register({
        name: 'debate_run',
        description: '兼容入口:一次跑完开题+交锋+制图(结果只回工具,不分段进会话)。新链路优先用 debate_open/round/synthesize 三步(动态显示)。',
        parameters: sidParam,
        output: textOut,
        execute: async (args, exec) => {
          const parent = exec.agent as ParentAgent | undefined
          if (!parent) throw new Error('debate_run requires a calling agent (exec.agent was undefined)')
          const session = getSession(args as { sessionId?: unknown })
          try {
            const a = (args ?? {}) as { hint?: unknown }
            const auto = resolveAuto(readEvents(parent), typeof a.hint === 'string' ? a.hint : '')
            session.config.auto = auto
            await runDebateLoop(subagents, parent, session, exec.signal)
            session.status = 'done'
            session.updatedAt = Date.now()
            return `## 成果地图(兼容单步)\n\n问题:${auto.question}\n\n${session.mapText ?? ''}`
          } catch (err) {
            fail(session, err)
          }
        },
      })
    } catch {
      // tools 服务不可用时 host 路由仍可建单,仅执行不可用
    }
  },
}
