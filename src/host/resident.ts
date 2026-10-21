/**
 * src/host/resident.ts — 常驻辩手对(回退一):建对 + 交棒 + 心跳 + 停机判定。
 *
 * 深模块:小外部接口(createResidentPair + driveResidentTurn + 读事件/判定纯函数),
 * 大实现(~400行:preset 继承/工具笼挂载/setup、followup→whenIdle→读后缀→校验→取结论、
 * 有界重投、进度感知超时)。S27 从 src/index.ts 摘出;8/8 已在 vitest 面上。
 */
import type { Context } from 'cordis'
import type {
  AgentPresetsLike, AgentsLike, ParentAgent, ResidentAgent, ResidentPair, ResidentSetupCtx,
} from './types'
import { cageLabel, resolveToolAllow, scopedToolGuard, textOf, toolAllowFor, visibleNamesOf } from './cage'
import { PROGRESS_POLL_MS, STEP_HARD_CAP_MS, STEP_STALL_MS, turnVerdict } from './cage'

/** 常驻辩手轮次尝试次数上限:provider 偶发内部错误时重投同一轮(同会话,记忆形状不变)。 */
export const RESIDENT_TURN_ATTEMPTS = 3

/**
 * 子 agent 固定 delegation 声明(照抄 dsh-subagent/child-agent 的 SUBAGENT_DELEGATION_CONTEXT):
 * runtime-context 贡献,不是 system section,所以部署的 system prompt 在 parent/child 间保持一致。
 */
export const SUBAGENT_DELEGATION_CONTEXT =
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

/** 文本块数组取文本(交棒结论提取用,与 cage.textOf 同源,复用 cage 实现)。 */
const blocksText = textOf

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

/** 本 epoch 最后一个 turn/end 的终端原因,映射到 subagent seam 词汇(completed/max-tokens/aborted/refusal/error)。 */
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
 * parentAgent 活体拥有:parent 销毁时连带回收;meta 另带子会话血统
 * (parentSession/isSeeded/origin/delegationDepth,照抄 dsh-subagent childSessionMeta):
 * origin=subagent 让侧边栏隐藏(parent 目录见 subagentCatalog,不堆未分组),
 * isSeeded=false 保证互盲(不继承 parent 历史)。
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
  const setupFor = (role: 'builder' | 'challenger'): ((agentCtx: any) => void | Promise<void>) => async (agentCtx: any) => {
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
      const sctx = agentCtx as ResidentSetupCtx
      sctx.systemPrompt.context({
        name: 'subagent:delegation',
        order: sctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: SUBAGENT_DELEGATION_CONTEXT,
      })
    } catch { /* 上下文挂不上不拦创建 */ }
    // 3) 工具笼(S16 白名单,整场有效,创建时 restrict 一次)。
    // 启动核对:用 agentCtx 自己的 schemas 视图与种子取交集,失效名剔掉;
    // 取不到(undefined)按种子先发、交 restrict 的 unknown 校验(挑战者终轮结论)。
    // 交集为空 → 显式失败,不无笼裸奔(建构者终轮)。
    try {
      let visible: string[] | undefined
      try {
        const all = (agentCtx as ResidentSetupCtx).tools?.schemas?.(agentCtx) as Array<{ name?: unknown }> | undefined
        visible = all === undefined ? undefined : visibleNamesOf(all)
      } catch { visible = undefined }
      const resolved = resolveToolAllow(toolAllowFor(role), visible)
      ;(agentCtx as ResidentSetupCtx).tools.restrict({ allow: resolved.allow })
      if (resolved.dropped.length > 0 || resolved.unverified) {
        try { (agentCtx as ResidentSetupCtx).systemPrompt.context({ name: 'debate:cage', order: 0, text: cageLabel(resolved.allow, resolved.dropped, resolved.unverified) }) } catch { /* 笼标签挂不上不拦创建 */ }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('empty-allow')) throw e
      /* restrict 失败时抛给创建事务回滚 */ throw new Error('resident-restrict-failed')
    }
    // 4) 执行期 guard:拦 scope-local(如 `subagent`),restrict/allow 都动不到它们。
    // one-shot 无挂载点,只挂常驻;guard 抛错不拦创建(拦不住也比建不起来强)。
    try {
      ;(agentCtx as ResidentSetupCtx).tools?.guard?.(scopedToolGuard)
    } catch { /* guard 挂不上不拦创建 */ }
  }
  // 子会话血统:parent 层级 +1(ParentAgent 面无 header,取不到则按 0 算,不拦创建)。
  const parentDepthRaw = (parent as { session?: { header?: { delegationDepth?: unknown } } })?.session?.header?.delegationDepth
  const parentDepth = typeof parentDepthRaw === 'number' && Number.isSafeInteger(parentDepthRaw) && parentDepthRaw >= 0 ? parentDepthRaw : 0
  const mkOne = async (role: 'builder' | 'challenger', route: { provider: string; model: string }): Promise<{ agent: ResidentAgent; dispose: () => Promise<void> }> => {
    const handle = await agents.create({
      sessionId: `${debateId}-${role}`,
      parentAgent: parent,
      meta: {
        cwd,
        parentSession: parent.session.id,
        isSeeded: false,
        origin: 'subagent',
        delegationDepth: parentDepth + 1,
        ...(presetId !== null && presetId !== '' ? { agentPreset: presetId } : {}),
      },
      agentOptions: { provider: route.provider, model: route.model },
      signal,
      setup: setupFor(role),
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
    id: `se-handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
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
