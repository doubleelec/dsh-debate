/**
 * dsh-session-enhance — Host 半区(原生包)。
 *
 * 两条线:
 * 1. webServer JSON 路由 /dsh-session-enhance/api/*:面板建单(start,带 sessionId+hint)后
 *    host 直接以后台任务跑完全程(open→round×N→synthesize),不再经过输入框触发语;
 *    state 轮询取实况,stop 中止。
 * 2. 模型工具:无。人工操作插件,不注册任何模型工具(host 直驱走 subagents 服务)。
 *
 * v0.3:host 直驱(parent 取自 ctx.agents.get(sessionId),agentOptions 锁定辩手模型)。
 */
import type { Context } from 'cordis'
import { rm } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

import type { DebateConfig, DebateMap, DebateRound, DebateStatus, TranscriptEntry } from './debate/debate'
import type { AgentsLike, ParentAgent, ResidentAgent, ResidentPair, TextContentBlock, AgentPresetsLike, ResidentSetupCtx, SubagentsLike } from './host/types'
export type { AgentsLike, ParentAgent, ResidentAgent, ResidentPair, TextContentBlock, AgentPresetsLike, ResidentSetupCtx, SubagentsLike } from './host/types'
import { DEBATER_TOOL_ALLOW, SYNTH_TOOL_ALLOW, toolAllowFor, resolveToolAllow, visibleNamesOf, cageLabel, scopedToolGuard, askSubagent, textOf, turnVerdict, STEP_STALL_MS, STEP_HARD_CAP_MS, PROGRESS_POLL_MS } from './host/cage'
export { DEBATER_TOOL_ALLOW, SYNTH_TOOL_ALLOW, toolAllowFor, resolveToolAllow, visibleNamesOf, cageLabel, scopedToolGuard, askSubagent, turnVerdict, STEP_STALL_MS, STEP_HARD_CAP_MS, PROGRESS_POLL_MS } from './host/cage'
import { SUBAGENT_DELEGATION_CONTEXT, RESIDENT_TURN_ATTEMPTS, readResidentEvents, heartbeatOf, extractHandoffConclusion, epochStopReason, epochStopDetail, createResidentPair, isRetriableTurnError, driveResidentTurn } from './host/resident'
export { SUBAGENT_DELEGATION_CONTEXT, RESIDENT_TURN_ATTEMPTS, readResidentEvents, heartbeatOf, extractHandoffConclusion, epochStopReason, epochStopDetail, createResidentPair, isRetriableTurnError, driveResidentTurn } from './host/resident'
import { DEFAULT_CONFIG, normalizeAnswer, isContinuationHint, SETTLED_DEFS_MAX, isOneSidedAccept, isTopicLoop, classifyQuestion, extractSessionContext, buildBuilderPrompt, buildBuilderRoundPrompt, buildChallengerPrompt, buildSynthesizerPrompt, renderTranscriptForSynthesizer, toDebateRound, roundConverged, convergedAtCap, isSaturated, pendingStalled, slimHandoff, formatPendingFocus, sectionText, parseAnswer, parseGaps, gapAge, extractDecisionSummary, buildFallbackSummary, DECISION_SECTION } from './debate/debate'
export { isTopicLoop }
export { renderTranscriptForSynthesizer, answerShapeOf, answerSpecOf } from './debate/debate'
import { BUILD_VERSION, assessVersions, type VersionFacts } from './version'
import { fromRecord, markInterrupted, renderReport, reportRelPath, STORAGE_TABLE, STORAGE_UNIT, toRecord } from './debate/persist'
import { findLens, type LensTemplate } from './debate/lenses'
// 跨仓任务(task):scan/build/launch/report/collect/stop —— 从 dsh-task-launcher 移植(ADR-0025)。
import { scanParent, defaultDeps as taskDefaultDeps } from './cross_tasks/scan'
import { buildMaterials, handoffText, reportFileName, reportMarkdown, assertAscii as assertTaskAscii, leftoverPlaceholders } from './cross_tasks/materials'
import { ensureGroupedSession, clearTempHandles as clearTaskTempHandles } from './cross_tasks/ensure-session'
import { parseRecommendText } from './cross_tasks/recommend'

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
  /** 实际驱动方式(single=单线分叉交替,resident=常驻交棒,oneShot=一次性起辩回退)。 */
  mode: 'single' | 'resident' | 'oneShot'
  /** 单线/常驻建对失败原因(成功回退时也记,便于面板/探针看清为什么没走单线)。 */
  residentError: string | null
  /**
   * 生效笼型(S16):常驻建对时 schemas 核对的结果(剔除失效名/未核对),并入已启动进度行。
   * one-shot 无核对挂载点,记 null(种子名单仍生效,见 askSubagent)。
   * 落盘:重启后仍可回答"这局跑在什么笼子里"。
   */
  cageNote: string | null
  /**
   * 打断点(S17 会话接管):stop/interrupt 时 transcript 停在哪(round/seq)。
   * transcript 本来就全保留,缺的只是"打断点在哪"这个映射——面板照此画线。
   * 开题前就停了记 null(没东西可指)。可选审计字段,老记录缺即 null(ADR-0021)。
   */
  interruptedAt: { round: number; seq: number } | null
  /**
   * 发起会话忙快照(S17 会话接管):每轮边界采样一次 parent.status,只记 running/闲。
   * 落盘的是快照不是引用(恢复的局没有活着的 parent,快照只是"那时忙不忙")。
   * 可选审计字段,老记录缺即 false(ADR-0021)。
   */
  parentBusy: boolean | null
  /**
   * 实时流:正在写的各方当前 turn 流式累计文本(key=role),面板 2s 轮询即见打字机效果。
   * turn 落 transcript 即清对应项;synthesizer 走 one-shot 无流,只有进度文案。
   * kind=text 是 assistant 文本增量;kind=tools 是工具心跳(读文件阶段文本还没出来时)。
   */
  streaming: Record<string, { round: number; kind: 'text' | 'tools'; text: string }>
  /**
   * 收尾陈述(v4):辩论结束后贴进对话区的那段决策摘要,用户据此定下一步。
   * 优先取制图输出的「决策摘要」段;制图员漏写时用判定数据兜底(见 buildFallbackSummary)。
   */
  decisionSummary: string | null
  /**
   * 结论文档相对工作区的路径(写成功才有)。
   * 只存相对路径:绝对路径由 targetCwd + 它拼出来,工作区搬家/换机器后仍然有效。
   */
  reportRel: string | null
  /** 最近一次落盘失败原因(null=成功或还没试过)。持久化失败绝不静默,但也绝不许拖垮辩论。 */
  persistError: string | null
  /** 结论文档写入失败原因(null=成功或还没试过)。 */
  reportError: string | null
  /** 单线分叉清扫失败原因(null=清干净或本局没走单线)。清扫失败不掩盖辩论结果,只留痕。 */
  sweepError: string | null
  /** 本局清掉的分叉会话 id(文档已落盘,草稿纸已撕)。 */
  sweptSessions: string[]
  /** 本局是从磁盘恢复的(宿主重启后仍打得开),不是本进程新建的。 */
  restored: boolean
  /**
   * 落盘触发器(host 建单时注入)。
   * pushEntry/setProgress 是同步的(model 事件回调里),不能 await,只能靠这个钩子把 ctx 带进来。
   * 可选:纯函数单测环境没有它,所以缺了也必须一切照常。
   */
  flush?: () => void
}

/**
 * 缺口年龄(调用方拼好传给收尾/报告):逐轮从 transcript 原文抽缺口,算存活。
 * transcript 按 round 聚合(两侧输出拼一起抽);开题轮(round 0)也参与——
 * R0 点名、R10 还没补的缺口,正是"一致没覆盖什么"。
 */
export function gapSpansOf(session: DebateSession): import('./debate/debate').GapSpan[] {
  const byRound = new Map<number, string[]>()
  for (const e of session.transcript) {
    if (e.round < 0) continue
    const cur = byRound.get(e.round) ?? []
    cur.push(e.text)
    byRound.set(e.round, cur)
  }
  return gapAge([...byRound].map(([round, texts]) => ({ round, gaps: parseGaps(texts.join('\n\n')) })))
}

/**
 * 出处指针存在性探针:验指针相对 targetCwd 是否存在。
 * 动态 import(宿主 node 直跑;vitest 下失败则返回 null,调用方不验)。
 * 只验存在,不验行号(extractPointers 已剥掉行号)。
 */
async function pointerExistsFn(cwd: string | undefined): Promise<((p: string) => boolean) | null> {
  if (cwd === undefined || cwd === '') return null
  try {
    const fs = await import('node:fs') as unknown as { existsSync(p: string): boolean }
    const path = await import('node:path') as unknown as { join(...p: string[]): string }
    return (p: string) => {
      try {
        return fs.existsSync(path.join(cwd, p))
      } catch {
        return false
      }
    }
  } catch {
    return null
  }
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
      id: `se-mirror-${session.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
  session.flush?.()
}

/**
 * 收集版本对账事实(磁盘探针失败一律降级为 null,不抛:版本显示不该拖垮面板)。
 * `running` 来自构建期内联常量——**这是本进程真正在跑的代码版本**,不是磁盘现在的版本。
 * @internal 导出供版本真值集成测试用(直接打真实构建产物 + 真实磁盘 manifest)。
 */
export async function versionFacts(): Promise<VersionFacts> {
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000)
  let disk: string | null = null
  let bundleMtimeMs: number | null = null
  try {
    const fs = await import('node:fs') as unknown as {
      readFileSync(p: string | URL, enc: string): string
      statSync(p: string | URL): { mtimeMs: number }
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL('../dsh.plugin.json', import.meta.url), 'utf-8')) as { version?: unknown }
      disk = typeof manifest.version === 'string' ? manifest.version : null
    } catch { /* 读不到就不对比版本号,只看 mtime */ }
    try {
      bundleMtimeMs = fs.statSync(new URL('./index.js', import.meta.url)).mtimeMs
    } catch { /* vitest 从源码直跑时没有 lib/index.js */ }
  } catch { /* fs 不可用:只报 running,面板退化为"无对账" */ }
  return { running: BUILD_VERSION, disk, bundleMtimeMs, startedAtMs }
}

/**
 * 本轮焦点块(v4 焦点账本 + S13 定义锁存 + S15 已决账本):把上一轮挑战者自报的未决清单
 * 原样带进下一轮 prompt,外加两本账——已接受判据(锁了什么尺子) + 已决事项(定了什么结论)。
 * 清单为空 / 上一轮没提供(null)时不加清单约束,但两本账照样带(收尾轮清单空了,锁和结论还在)。
 * 锁存定义:从历史 accepted 轮里收"判据"行(挑战者 concession 里"接受…定义…"的写法),
 * 原样带进 prompt,挑战者只能挑战判据本身,不能悄悄换尺重算。
 * 已决事项同理:concession 里接受的非定义行,已决不得重开,除非给反例。
 */
export function focusBlockOf(session: DebateSession): string {
  const last = session.rounds[session.rounds.length - 1]
  const items = last?.pendingItems
  const defs = settledDefsOf(session)
  const settled = settledItemsOfSession(session)
  if ((!items || items.length === 0) && defs.length === 0 && settled.length === 0) return ''
  return formatPendingFocus(items ?? [], defs, settled)
}

/**
 * 已接受判据收集(S13 定义锁存):从双方 transcript 的 concession 段里收
 * "接受…定义/口径/尺度/判据/判定线…"的行,去重后返回。
 * 只认 concession 段里的"接受"行,不碰正文——正文里的"接受①②"是让步,不是判据。
 * 上限见 SETTLED_DEFS_MAX(账本要短,先接受的先锁);80 字截断只动展示,
 * prompt 里仍是原文,不叫"非原样"(原样指语义不改写,不是字符数)。
 */
export function settledDefsOf(session: DebateSession): string[] {
  const defs: string[] = []
  const seen = new Set<string>()
  for (const e of session.transcript) {
    if (e.role !== 'challenger' && e.role !== 'builder') continue
    const m = e.text.match(/concession([\s\S]*?)(?=\n##\s|\nMODEL:|$)/i)
    if (!m) continue
    for (const line of m[1].split('\n')) {
      const t = line.trim().replace(/^[-*\d]+\s*[)）.、:：]?\s*/, '')
      if (!/接受/.test(t) || !/(定义|口径|尺子|尺度|判据|判定线)/.test(t)) continue
      const key = t.slice(0, 40)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      defs.push(t.length > 80 ? `${t.slice(0, 80)}…` : t)
      if (defs.length >= SETTLED_DEFS_MAX) return defs
    }
  }
  return defs
}

/** 已决事项条数上限:与判据账本同口径(账本要短,先接受的先记)。 */
export const SETTLED_ITEMS_MAX = 3

/**
 * 已决事项收集(S15 中间结论账本):concession 段里"接受…"但**不是**判据定义的行。
 * 三本账分工:未决清单=还要补什么;已接受判据=锁了什么尺子;已决事项=定了什么结论。
 * 线上实测:R16"轮=2h 人在场"、R18 两合取,两边都不收,下一轮 invisible,R19 换个角度重开。
 * 定义行归 settledDefsOf,不进这里(两本账不重账,判据见 debate.ts isSettledDefLine)。
 * 纯收集缝在 debate.ts(同名函数,收 transcript 数组);这里是 session 版,供 focusBlockOf 用。
 */
export function settledItemsOfSession(session: DebateSession): string[] {
  const { settledItemsOf } = require('./debate/debate') as typeof import('./debate/debate')
  return settledItemsOf(session.transcript)
}

/**
 * 对话区镜像摘要(v4)。
 *
 * 实测动机(2026-10 跑局):旧行为把每一步全文原样 append 进用户会话,10 轮灌进
 * 10.9 万字(挑战者单轮 8000 字),对话区不可读、上下文被吃光。全文仍在 transcript
 * (面板逐段折叠看),镜像只留「结论摘要」前几行 + answer,够判断局势即可。
 */
export function chatDigest(text: string, maxLines = 3): string {
  const summary = sectionText(text, '结论摘要')
  const body = summary !== '' ? summary : text
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const head = lines.slice(0, maxLines).join('\n')
  const answer = parseAnswer(text)
  const tail = answer !== '' ? `\n→ 当前答案:${answer}` : ''
  return `${head}${tail}`
}

/**
 * 收尾陈述包装(v4):辩论结束后贴进对话区的最终消息。
 * 自足可读:不依赖面板也能看懂结论/分歧/下一步;完整地图指向面板,不再灌一遍。
 */
export function finalStatement(question: string, decision: string): string {
  const body = decision.startsWith('##') ? decision : `## ${DECISION_SECTION}\n${decision}`
  return [
    `⚔ 辩论结束 · 结论`,
    ``,
    `问题:${question}`,
    ``,
    body,
    ``,
    `---`,
    `完整成果地图(五件套:视角/论证/依据/分歧/缺口)在辩论面板里看;需要贴给别人时点面板里的「复制成果地图」。`,
  ].join('\n')
}

/** @internal 内存单表(供单元测试调整),不构成公开 API。 */
export const sessions = new Map<string, DebateSession>()
let seq = 0

function newId(): string {
  seq += 1
  return `se-${Date.now().toString(36)}-${seq}`
}

// ───────────────────────── 持久化:整局记录 + 结论文档(ADR-0019) ─────────────────────────
//
// 两条独立的耐久化路径,各自的理由不同:
// - 整局记录进 ctx.storage 的 KV 单元 → 宿主重启后旧局仍打得开(修 unknown-id);
// - 结论文档写进工作区 docs/debates/ → 给人和未来的 agent 一个有地址的产物,压缩吃不掉它。
//
// **刻意不 import `@deepseek-ai/dsh-storage`**:插件自己 node_modules 里那份是 0.1.1-rc.2,
// 宿主实际跑的是 0.2.0-rc.2(实测两版本并存)。拿旧包的类型去喂新实现是埋雷,所以只按
// 文档化的成员做鸭子类型;少一个成员就整体降级为"不持久化",绝不让插件加载失败。

/** KV 单元的最小结构面(见 dsh-storage 的 backend 约定)。 */
interface KvUnitLike {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  close(): Promise<void>
}

/** 存储枢纽的最小结构面。 */
interface StorageHubLike {
  backend?: { get(name: string): { kv?: { open(descriptor: unknown): Promise<KvUnitLike> } } | undefined }
}

/** 后端注册名:base 组合包里 `storage-domain` 的 config 就是 `backend: json`。 */
const STORAGE_BACKEND = 'json'

let store: KvUnitLike | null = null
/** 试过一次就不再重试:不可用是配置事实,不是瞬时故障,别让每轮都白等一次失败。 */
let storeTried = false
let storeError: string | null = null

/**
 * 懒开存储单元并缓存。
 * 单元名用 `dsh_debate`(下划线)——`UNIT_NAME_RE` 是 `/^[a-z][a-z0-9_]*$/`,连字符非法(实测)。
 * 用 `per-record` 布局:一局一条文档,每轮保存只重写这一局,不连带整表。
 */
async function openStore(ctx: Context): Promise<KvUnitLike | null> {
  if (store !== null) return store
  if (storeTried) return null
  storeTried = true
  try {
    const hub = ctx.get('storage') as unknown as StorageHubLike | undefined
    const kv = hub?.backend?.get(STORAGE_BACKEND)?.kv
    if (!kv) { storeError = 'storage-unavailable'; return null }
    store = await kv.open({
      name: STORAGE_UNIT,
      version: 1,
      tables: [STORAGE_TABLE],
      hasGlobal: false,
      layout: 'per-record',
    })
    storeError = null
    return store
  } catch (e) {
    storeError = e instanceof Error ? e.message : String(e)
    return null
  }
}

/**
 * 落盘一局。**永不抛**:一局跑成功的辩论不能因为写盘失败变成失败。
 * 但也绝不静默——原因记在 session.persistError 上,面板可观测(与 mirror 同一原则)。
 */
async function persist(ctx: Context, session: DebateSession): Promise<void> {
  const unit = await openStore(ctx)
  if (unit === null) { session.persistError = storeError ?? 'storage-unavailable'; return }
  try {
    await unit.putRecord(STORAGE_TABLE, session.id, toRecord(session))
    session.persistError = null
  } catch (e) {
    session.persistError = e instanceof Error ? e.message : String(e)
  }
}

/**
 * 落盘调度:合并写入。
 * pushEntry/setProgress 都在同步回调里,不能 await;同一局同时只允许一个写在飞,
 * 期间的新请求只置脏标记,写完后若脏再写一次。落后最多一次写入,不会积压成队列。
 */
const persisting = new Map<string, boolean>()
const persistDirty = new Map<string, boolean>()

function schedulePersist(ctx: Context, session: DebateSession): void {
  if (persisting.get(session.id) === true) { persistDirty.set(session.id, true); return }
  persisting.set(session.id, true)
  void (async () => {
    try {
      do {
        persistDirty.set(session.id, false)
        await persist(ctx, session)
      } while (persistDirty.get(session.id) === true)
    } finally {
      persisting.delete(session.id)
      persistDirty.delete(session.id)
    }
  })()
}

/**
 * 把一台 KV 单元里的记录装回内存单表。
 * 逐条独立:`fromRecord` 返回 null 的坏记录跳过,不拖垮整张表。
 * 上次记 running 的,说明进程是半途消失的——标成 stopped 并说清原因,
 * 因为"面板显示还在跑、实际永远不动"比"显示已中断"更糟。
 * @returns 实际恢复的局数。
 */
async function loadPersisted(ctx: Context): Promise<number> {
  const unit = await openStore(ctx)
  if (unit === null) return 0
  try {
    const { tables } = await unit.loadAll()
    const rows = tables[STORAGE_TABLE] ?? {}
    let n = 0
    for (const raw of Object.values(rows)) {
      const rec = fromRecord(raw)
      if (rec === null) continue
      const fixed = markInterrupted(rec, '宿主重启,本局已中断(记录已从磁盘恢复,可查看结论)')
      const restored: DebateSession = {
        id: fixed.id,
        config: fixed.config,
        status: fixed.status,
        round: fixed.round,
        transcript: fixed.transcript,
        map: fixed.map,
        mapText: fixed.mapText,
        error: fixed.error,
        createdAt: fixed.createdAt,
        updatedAt: fixed.updatedAt,
        // 恢复的局没有活着的 parent,也没有在写的流:镜像/直播这两个进程内概念一律按关闭处理。
        mirrorToChat: false,
        progress: fixed.progress,
        mirrorCount: fixed.mirrorCount,
        mirrorError: fixed.mirrorError,
        parentSid: fixed.parentSid,
        stopReason: fixed.stopReason,
        rounds: fixed.rounds,
        mode: fixed.mode,
        residentError: fixed.residentError,
        cageNote: fixed.cageNote ?? null,
        interruptedAt: fixed.interruptedAt ?? null,
        parentBusy: fixed.parentBusy ?? null,
        streaming: {},
        decisionSummary: fixed.decisionSummary,
        reportRel: fixed.reportRel,
        persistError: null,
        reportError: null,
        sweepError: null,
        sweptSessions: [],
        restored: true,
      }
      restored.flush = () => schedulePersist(ctx, restored)
      sessions.set(restored.id, restored)
      n += 1
    }
    return n
  } catch (e) {
    storeError = e instanceof Error ? e.message : String(e)
    return 0
  }
}

/**
 * 停机原因的人话口径(结论文档用)。
 * 与面板/对话区同一份说法——同一件事在三个地方出现三种措辞,读的人就要重新对一遍。
 */
export function stopReasonText(session: DebateSession): string {
  const r = session.stopReason
  const n = session.rounds.length
  // 上限处一致算 convergence(判据真实),但说法必须标出"压线":
  // 用户要评估的是"轮数给得合不合理",一句"共识收敛"会让他以为提前谈完了。
  const cap = convergedAtCap(r, session.rounds, session.config.maxRounds)
  if (r === null) return session.status === 'done' ? '无(未记录)' : '未停机'
  if (r === 'convergence') {
    return cap
      ? `压线共识(第 ${n} 轮一致,但上限就是 ${session.config.maxRounds} 轮:谈满了才收,不是提前收敛)`
      : `共识收敛(第 ${n} 轮双方 agree 同一答案)`
  }
  if (r === 'saturation') {
    return (session.rounds[n - 1]?.pendingItems?.length ?? 0) > 0
      ? `焦点停滞(第 ${n} 轮起未决清单连续两轮没变)`
      : `覆盖饱和(第 ${n} 轮无新增视角/缺口/状态变化)`
  }
  if (r === 'maxRounds') return `跑满上限(${session.config.maxRounds} 轮)`
  return `手动跳制图(第 ${n} 轮后)`
}

/**
 * 写结论文档(ADR-0019)。**先落盘再报路径**——路径先说出口而文件没写成,比不报更糟。
 * @returns 相对工作区的路径;失败返回 null 并把原因记在 session.reportError。
 */
async function writeReport(session: DebateSession): Promise<string | null> {
  const cwd = session.config.targetCwd
  if (cwd === undefined || cwd === '') { session.reportError = 'no-target-cwd'; return null }
  try {
    const fs = await import('node:fs') as unknown as {
      mkdirSync(p: string, o: { recursive: boolean }): void
      writeFileSync(p: string, data: string, enc: string): void
    }
    const path = await import('node:path') as unknown as { join(...p: string[]): string; dirname(p: string): string }
    const auto = session.config.auto
    const rel = reportRelPath(session.createdAt, auto?.question ?? '', session.id)
    const abs = path.join(cwd, rel)
    const text = renderReport({
      id: session.id,
      question: auto?.question ?? '',
      questionType: auto?.questionType ?? '',
      lenses: auto?.lenses ?? [],
      targetCwd: cwd,
      createdAt: session.createdAt,
      finishedAt: Date.now(),
      status: session.status,
      error: session.error,
      stopReason: session.stopReason,
      maxRounds: session.config.maxRounds,
      decisionSummary: session.decisionSummary,
      mapText: session.mapText,
      rounds: session.rounds,
      transcript: session.transcript,
      generator: `dsh-session-enhance v${BUILD_VERSION}`,
      stopText: stopReasonText(session),
      gapSpans: gapSpansOf(session),
    })
    // 目录可能还不存在(targetCwd 建单时只校验过存在性,docs/debates 未必有)。
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf-8')
    session.reportRel = rel
    session.reportError = null
    return rel
  } catch (e) {
    session.reportError = e instanceof Error ? e.message : String(e)
    return null
  }
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

/** 最大交锋轮数上限:10 轮题刚好压线(S10/S11 实测),超 20 未收敛多半真谈不拢。 */
export const MAX_ROUNDS_CAP = 20

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
  const floored = Number.isFinite(maxRoundsRaw) ? Math.max(1, Math.floor(maxRoundsRaw)) : DEFAULT_CONFIG.maxRounds
  // 钳制要留痕:用户填 30,面板不能一边显示 30 一边跑 20(线上实测:填 20 静默跑 10)。
  const maxRounds = Math.min(MAX_ROUNDS_CAP, floored)
  const note = floored > MAX_ROUNDS_CAP ? `轮数 ${floored} 已按上限 ${MAX_ROUNDS_CAP} 钳制(超 20 轮未收敛多半真谈不拢)` : undefined
  // 裁判已从 interface 移除(ADR-0002:默认关且无实现,留着就是死配置);面板也不传。
  // targetCwd:评审别家工程时填(空=沿用发起会话 cwd);建单即校验存在性,fail fast。
  const targetCwd = typeof body.targetCwd === 'string' ? body.targetCwd.trim() : ''
  const cfg: DebateConfig = {
    builder: route(body.builder, DEFAULT_CONFIG.builder),
    challenger: route(body.challenger, DEFAULT_CONFIG.challenger),
    synthesizer: route(body.synthesizer, DEFAULT_CONFIG.synthesizer),
    maxRounds,
    ...(note !== undefined ? { note } : {}),
    ...(targetCwd !== '' ? { targetCwd } : {}),
  }
  return { config: cfg }
}

/**
 * 执行时自动判断:从 parent 会话提炼问题/题型/lens/背景。
 * hint 为触发语里模型转述的用户意图(可空);hint 为空则取最近一条 user 消息当问题。
 * hint 是承接语(只有指代、没有实质问题,如"就以上问题继续辩论")则视为无 hint:
 * question 本该是对用户意图理解后的清晰描述,不是一句指代(S15)。
 */
export function resolveAuto(events: { type: string; data?: unknown }[], hint: string): NonNullable<DebateConfig['auto']> {
  const usableHint = isContinuationHint(hint) ? '' : hint.trim()
  const question = usableHint !== '' ? usableHint : lastUserText(events)
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
    if (t === '' || /^(?:辩论单|⚔\s*辩论|辩论开题|交锋第|成果地图)/.test(t) || /^(?:(?:那请)?继续(?:处理|吧)?|好|好的|收到|嗯|明白|了解|确认|ok|okay)(?:[，,、\s]*(?:(?:我)?(?:继续(?:处理|吧)?|处理)|收到|好的?))*[。！!，,\s]*$/i.test(t)) continue
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
/** fork 种子事件面(自实现 buildForkSeed 的输入输出同形,不引宿主内部包)。 */
export interface SeedEvent {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

/**
 * fork 种子自实现(照抄 dsh-session/fork.ts buildForkSeed,不引宿主内部包):
 * 切源事件 inclusive 前缀 + session/end-seed 标记,再补开尾 turn 的 forked closer
 * (openTurnClosers 同形:turn/start 未配对 turn/end 即开尾,补 tool 回收结果 + step/end + turn/end;
 * 开尾 turn 由新会话自然收敛不成立——种子里的开 turn 会污染新会话首 turn 边界,必须闭合)。
 */
export function buildDebateForkSeed(
  events: SeedEvent[],
  boundary: number,
): SeedEvent[] {
  const prefix = events.slice(0, boundary + 1)
  const last = events[boundary]
  const at = last?.time ?? Date.now()
  const seqBase = (typeof last?.seq === 'number' ? last.seq : boundary) + 1
  const out: SeedEvent[] = [...prefix]
  out.push({ type: 'session/end-seed', seq: seqBase, time: at, data: { inherited: true } })
  // 开尾检测:最后一个 turn/start 之后有没有配对的 turn/end。
  let openTurn: unknown = null
  let openStep: unknown = null
  for (const e of prefix) {
    if (e.type === 'turn/start') { openTurn = (e.data as { turn?: unknown } | undefined)?.turn ?? true; openStep = null }
    else if (e.type === 'turn/end') { openTurn = null; openStep = null }
    else if (e.type === 'step/start') { openStep = (e.data as { step?: unknown } | undefined)?.step ?? true }
    else if (e.type === 'step/end') { openStep = null }
  }
  let seq = seqBase + 1
  if (openTurn !== null) {
    if (openStep !== null) {
      out.push({ type: 'step/end', seq: seq++, time: at, data: { turn: openTurn, step: openStep } })
    }
    out.push({ type: 'turn/end', seq: seq++, time: at, data: { turn: openTurn, reason: { kind: 'forked' } } })
  }
  return out
}

/** 单线交替载体:分叉会话 = 可直接 driveResidentTurn 的 ResidentAgent + 会话 id + dispose。 */
export interface SingleThread {
  readonly sessionId: string
  readonly agent: ResidentAgent
  dispose(): Promise<void>
}

/**
 * 单线分叉创建:从发起会话 fork 一个子会话当交替线(种子=发起会话当前上下文)。
 * 照抄原生 fork 链:seed + inheritedEventCount + meta(parentSession/isSeeded=true)
 * + agentOptions(发起会话当前模型,单模型双角色:agentDefaultModel.currentSelection,
 * 与 fork 链同源;拿不到则不带,让 preset 默认模型接管) + setup(join preset 生成)。
 * cwd 三级:显式目标工作区 > 发起会话 cwd > 进程目录(与 createResidentPair 同序)。
 * 注意:分叉 origin 不带 subagent(与常驻对区分,分叉在侧边栏可见、可回看)。
 */
export async function createSingleThread(
  ctx: Context,
  agents: AgentsLike,
  parent: ParentAgent,
  debateId: string,
  signal: AbortSignal,
  targetCwd?: string,
): Promise<SingleThread> {
  const get = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
  const presets = get('agentPresets') as AgentPresetsLike | undefined
  const presetId = presets?.defaultId ?? null
  const parentCtx = (parent as any)?.ctx as unknown | undefined
  const inheritCwd = (parent as any)?.session?.header?.cwd as string | undefined
  const cwd = targetCwd !== undefined && targetCwd !== '' ? targetCwd
    : inheritCwd !== undefined && inheritCwd !== '' ? inheritCwd : process.cwd()
  // 种子:发起会话当前事件前缀(全量,boundary=末尾)。
  const sourceEvents = readParentEvents(parent) as SeedEvent[]
  const boundary = sourceEvents.length - 1
  const seed = boundary >= 0 ? buildDebateForkSeed(sourceEvents, boundary) : undefined
  const sessionId = `${debateId}-single`
  // 模型锁定:单线是单模型双角色,分叉跑发起会话当前模型(与 fork 链同源)。
  let agentOptions: { provider: string; model: string } | undefined
  try {
    const dm = get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined
    const sel = dm?.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
      agentOptions = { provider: sel.provider, model: sel.model }
    }
  } catch { /* 拿不到则不带,让 preset 默认模型接管 */ }
  const handle = await agents.create({
    sessionId,
    parentAgent: parent,
    meta: {
      cwd,
      parentSession: parent.session.id,
      isSeeded: true,
      ...(presetId !== null && presetId !== '' ? { agentPreset: presetId } : {}),
    },
    ...(seed ? { seed, inheritedEventCount: boundary + 1 } : {}),
    ...(agentOptions ? { agentOptions } : {}),
    setup: async (agentCtx: unknown) => {
      try {
        if (presets?.composeFrom && parentCtx) {
          presets.composeFrom(agentCtx, parentCtx)
        } else if (presets && presetId !== null && presetId !== '') {
          await presets.mount(agentCtx, presetId)
        }
      } catch { /* join 失败不拦创建 */ }
      try {
        (agentCtx as ResidentSetupCtx).systemPrompt.context({
          name: 'subagent:delegation',
          order: (agentCtx as ResidentSetupCtx).systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
          text: SUBAGENT_DELEGATION_CONTEXT,
        })
      } catch { /* 上下文挂不上不拦创建 */ }
    },
  })
  const agent = handle.agent as ResidentAgent
  return { sessionId, agent, dispose: handle.dispose }
}

/**
 * 单线分叉落盘清扫(辩论结束四步收尾的后三步,文档已落盘之后才调,顺序不能反)。
 * 临时会话+文档存档:分叉是计算草稿纸,结论全在文档里,盘文件不留。
 * 只删 `se-<debateId>-single` 一个确定性 id,不碰别的(卡死前缀,不误删)。
 * ① detach:从 workspace 注册表摘引用(分叉建时可能已挂进去,幂等空跑居多)
 * ② rm:删会话目录(宿主无删会话 API,插件跑在宿主进程里直接走文件系统)
 * 失败只留痕不抛:清扫失败不掩盖辩论结果,只记 session.sweepError。
 */
export async function sweepSingleThread(
  ctx: Context,
  debateId: string,
): Promise<{ detached: string[]; removed: string[]; errors: string[] }> {
  const detached: string[] = []
  const removed: string[] = []
  const errors: string[] = []
  const sid = `${debateId}-single`
  const get = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
  try {
    const registry = get('workspaceRegistry') as
      | { list(): Array<{ detachSession(sid: string): Promise<void> }> }
      | undefined
    if (registry) {
      for (const ws of registry.list()) {
        try { await ws.detachSession(sid); detached.push(sid) } catch (e) {
          errors.push(`detach ${sid}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  } catch (e) {
    errors.push(`registry: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    const persistence = get('sessionPersistence') as
      | { locate(meta: { cwd?: string; id: string }): { path: string } }
      | undefined
    if (persistence) {
      try {
        const ss = get('sessions') as unknown as
          | { store?: { get?: (k: string) => { session?: { header?: { cwd?: string } } } } }
          | undefined
        const header = ss?.store?.get?.(sid)?.session?.header
          ?? (get('agents') as { get(id: string): { session?: { header?: { cwd?: string } } } | undefined } | undefined)?.get(sid)?.session?.header
        const { path } = persistence.locate({ cwd: header?.cwd, id: sid })
        const { dirname } = await import('node:path')
        await rm(dirname(path), { recursive: true, force: true })
        removed.push(sid)
      } catch (e) {
        errors.push(`rm ${sid}: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      errors.push('sessionPersistence unavailable')
    }
  } catch (e) {
    errors.push(`locate: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { detached, removed, errors }
}

/** 常驻辩手对:整场存活,host 在两者之间交棒(handoff)。(面已迁 host/types,重导出见顶。) */

/** 每场辩论的中止器(stop 路由 abort,后台任务退出)。 */
const controllers = new Map<string, AbortController>()

// ───────────────────────── 跨仓任务(task)辅助(ADR-0025) ─────────────────────────
// 从 dsh-task-launcher 移植：stamp/created/parentRootOf + taskLaunchControllers。
// task 路由挂 /dsh-session-enhance/api/task/*,与 deliberation 路由同文件逐条注册。

/** 每次 launch 一仓一控制器(stop 按 key abort 未完成的拉起；已冒出的不回收)。 */
const taskLaunchControllers = new Map<string, AbortController>()

function taskStampOf(nowMs: number = Date.now()): string {
  const d = new Date(nowMs)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function taskCreatedOf(nowMs: number = Date.now()): string {
  const d = new Date(nowMs)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 自建满血 parent(照抄 webhook 样板):meta.agentPreset + setup 里 mount 默认 preset。
 * 不挂 preset 的 parent 落在空 global 层,子 agent 继承下来只有宿主默认的少量工具。
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

/** 读 parent 会话事件(host 直驱用)。 */
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

/** 标记失败并抛错(host 直驱用)。 */
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
  let single: SingleThread | null = null
  try {
    const get = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
    const subagents = get('subagents') as SubagentsLike | undefined
    if (!subagents) throw new Error('subagents service unavailable')
    const agents = get('agents') as AgentsLike | undefined
    // 真实会话历史:硬触发时 parent 是自建的(空事件),历史从 sessions.store 按真实 sid 读。
    // sessions.store.get(sid).session.snapshotEvents(0) → 事件流,与 readParentEvents 同形。
    const readRealSessionEvents = (realSid: string): { type: string; data?: unknown }[] => {
      try {
        if (realSid === '') return []
        const ss = get('sessions') as unknown as { store?: { get?: (k: string) => unknown } } | undefined
        const rec = ss?.store?.get?.(realSid) as { session?: { snapshotEvents?: (from?: number) => unknown } } | undefined
        const snap = rec?.session?.snapshotEvents
        if (typeof snap !== 'function') return []
        const evs = snap.call(rec?.session, 0) as { type: string; data?: unknown }[] | undefined
        return Array.isArray(evs) ? evs : []
      } catch {
        return []
      }
    }
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
        const full = await createFullParent(ctx, agents, `se-parent-${session.id}`, session.config.synthesizer, signal, session.config.targetCwd)
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
    // 历史:真实 parent 读自有事件;自建 parent(硬触发)按真实 sid 从 sessions.store 读,
    // 辩手开题能引用前面聊的上下文,不再是孤立的一句话。
    const parentEvents = readParentEvents(parent)
    const historyEvents = owned !== null ? readRealSessionEvents(sid) : []
    const autoEvents = historyEvents.length > 0 ? historyEvents : parentEvents
    session.config.auto = resolveAuto(autoEvents, hint)
    const auto = session.config.auto
    if (auto.question === '') throw new Error('empty-question:输入框没有问题,先写下要辩论的问题再点开始')
    // 秒级直播:建单→自动判断完成即有进度,不用等第一个模型输出。
    setProgress(session, `已启动:「${auto.question}」(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model},共 ${session.config.maxRounds} 轮)。建构者开写中…`)
    mirror(parent, session, `⚔ 辩论开始:「${auto.question}」(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model},共 ${session.config.maxRounds} 轮,制图 ${session.config.synthesizer.model})。开题马上到,进度同步见面板。`)
    const live = {
      onStart: (who: string): void => {
        setProgress(session, who)
      },
      onSide: (who: string, title: string, text: string): void => {
        setProgress(session, `${title}已出,面板/对话区同步`)
        // v4:只镜像「结论摘要」前几行 + answer,不再把全文灌进对话区
        // (旧行为 10 轮灌 10.9 万字,对话区不可读);全文仍在 transcript,面板可看。
        mirror(parent, session, `**${title}**\n${chatDigest(text)}`)
      },
    }
    // S1:常驻优先——建对成功则开题+交锋全走交棒(handoff),记忆留在常驻会话里;
    // 建对失败(agents 不可用/setup 被拒)才回退一次性起辩,transcript 为空时才可退。
    if (agents) {
      try {
        setProgress(session, `单线分叉创建中(交替线,种子=当前上下文)…`)
        single = await createSingleThread(ctx, agents, parent, session.id, signal, session.config.targetCwd)
        session.mode = 'single'
        session.residentError = null
        // S16:生效笼型并入已启动行。核对源 = parent 的 schemas 全局视图(与 debug-agent 同源);
        // 取不到按种子先发、标未核对(挑战者终轮结论:不把可选接口当启动硬依赖)。
        try {
          const tools = (parent as unknown as { ctx?: { get(name: string): unknown } }).ctx?.get('tools') as
            | { schemas?: (scope?: unknown) => Array<{ name?: unknown }> }
            | undefined
          const all = tools?.schemas?.(parent) as Array<{ name?: unknown }> | undefined
          const resolved = resolveToolAllow(DEBATER_TOOL_ALLOW, all === undefined ? undefined : visibleNamesOf(all))
          session.cageNote = cageLabel(resolved.allow, resolved.dropped, resolved.unverified)
        } catch {
          session.cageNote = cageLabel(DEBATER_TOOL_ALLOW, [], true)
        }
        // 笼标签进已启动行:会话可见生效笼型,不只写日志(辩论结论,开局挂一次,不必每轮刷新)。
        setProgress(session, `已启动:「${auto.question}」(单线交替,共 ${session.config.maxRounds} 轮)。${session.cageNote}。建构者开写中…`)
      } catch (e) {
        if (signal.aborted) throw new Error('aborted')
        // 单线失败原因先留着(面板/探针要能回答"为什么这局不是单线");常驻再失败才覆盖。
        const singleError = (e as Error)?.message ?? String(e)
        try {
          setProgress(session, `常驻辩手建对中(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model})…`)
          pair = await createResidentPair(ctx, agents, parent, session.id, session.config.builder, session.config.challenger, signal, session.config.targetCwd)
          session.mode = 'resident'
          // 笼标签进已启动行:会话可见生效笼型,不只写日志(辩论结论,开局挂一次,不必每轮刷新)。
          setProgress(session, `已启动:「${auto.question}」(建构 ${session.config.builder.model} vs 挑战 ${session.config.challenger.model},共 ${session.config.maxRounds} 轮)。${session.cageNote}。建构者开写中…`)
        } catch (e2) {
          if (signal.aborted) throw new Error('aborted')
          // 回退必须可观测:单线、常驻两段失败原因都留(分号隔开),面板/探针能回答整条回退链。
          session.residentError = `single:${singleError}; resident:${(e2 as Error)?.message ?? String(e2)}`
          session.mode = 'oneShot'
          setProgress(session, `单线/常驻均失败(${session.residentError}),回退一次性起辩…`)
          mirror(parent, session, `⚠ 单线分叉与常驻建对均失败,已回退一次性起辩。原因:${session.residentError}`)
          pair = null
        }
      }
    } else {
      session.mode = 'oneShot'
      session.residentError = 'agents service unavailable'
    }
    try {
      if (single) {
        await stepOpenSingle(single, session, signal, {
          onStart: () => live.onStart('建构者开写中(单线)…'),
          onSide: (role, text) => live.onSide(role,
            role === 'builder' ? '建构者开题(单线)' : '挑战者开题(单线·见建构原文)',
            `问题:${auto.question}\n题型:${auto.questionType}\n\n${text}`),
        })
      } else if (pair) {
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
      // 开题即失败且走的是常驻/单线:成对回收,不留孤儿会话。
      if (pair && session.round < 0) {
        try { await pair.dispose() } catch { /* 回收失败不掩盖开题错 */ }
        pair = null
      }
      if (single && session.round < 0) {
        try { await single.dispose() } catch { /* 回收失败不掩盖开题错 */ }
        single = null
      }
    }
    setProgress(session, `开题完成,进入第 1/${session.config.maxRounds} 轮交锋`)
    let stop: 'convergence' | 'saturation' | 'maxRounds' | null = null
    for (let r = 1; r <= session.config.maxRounds; r++) {
      if (signal.aborted) throw new Error('aborted')
      // S17 接管快照:每轮边界采一次发起会话忙闲(轮询不订阅,host 侧无 parent.ctx 监听保证)。
      try { session.parentBusy = parentBusyOf(parent) } catch { /* 采样失败不拦轮次 */ }
      // 常驻已建对则整场走交棒;中途失败即停,不中途切一次性(记忆形状不同,混跑污染 transcript)。
      let bOut: string
      let cOut: string
      let relayChars = 0
      if (single) {
        const out = await stepRoundSingle(single, session, signal, {
          onStart: (role) => live.onStart(role === 'builder' ? `第 ${r} 轮建构方开写中(单线)…` : `第 ${r} 轮挑战方开写中(单线)…`),
          onSide: (role, text) => live.onSide(role,
            role === 'builder' ? `交锋第 ${r}/${session.config.maxRounds} 轮·建构方(单线)` : `交锋第 ${r}/${session.config.maxRounds} 轮·挑战方(单线)`,
            text),
        })
        bOut = out.builderOut
        cOut = out.challengerOut
        relayChars = out.builderRelayChars
      } else if (pair) {
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
      // 出处指针审计:存在性探针相对 targetCwd 验,只记 rounds[].pointerAudit,不 gate 停机。
      const exists = await pointerExistsFn(session.config.targetCwd)
      const verdict = recordRoundAndJudge(session, r, bOut, cOut, relayChars, exists ?? undefined)
      if (verdict === 'convergence') {
        stop = 'convergence'
        const atCap = r >= session.config.maxRounds
        setProgress(session, atCap
          ? `第 ${r} 轮双方认可同一答案,但这已经是上限轮(${session.config.maxRounds} 轮):压线收敛`
          : `第 ${r}/${session.config.maxRounds} 轮双方认可同一答案,提前停机`)
        mirror(parent, session, atCap
          ? `✅ 第 ${r} 轮双方 agree 同一答案,但上限就是 ${session.config.maxRounds} 轮——这是压线共识,不是提前收敛。轮数给得刚好还是偏紧,看收尾陈述里的提示再定。进入制图。`
          : `✅ 共识收敛:第 ${r} 轮双方 agree 同一答案,交锋提前结束,进入制图。`)
        break
      }
      if (verdict === 'saturation') {
        stop = 'saturation'
        const stalled = session.rounds[session.rounds.length - 1]?.pendingItems
        // 停滞优先于循环:清单逐条相同 × 多轮是更强的停机信号,循环判据已显式排除静止清单,
        // 这里再按顺序兜底一次(判据改了顺序也不误报)。
        const isStalled = pendingStalled(session.rounds)
        const looped = !isStalled && isTopicLoop(session.rounds)
        setProgress(session, looped
          ? `第 ${r}/${session.config.maxRounds} 轮议题循环(清单清不空、答案面不动),提前停机`
          : `第 ${r}/${session.config.maxRounds} 轮焦点停滞/无新增,提前停机`)
        mirror(parent, session, looped
          ? `🛑 议题循环:第 ${r} 轮起连续多轮清单清不空、答案面不动(同一格子里换尺子打转),再谈只是烧轮次,提前收尾进入制图。结论面没动,不是没谈完。`
          : isStalled && stalled && stalled.length > 0
            ? `🛑 焦点停滞:第 ${r} 轮起未决清单连续两轮没变(仍是 ${stalled.length} 条),再谈也不会推进,提前收尾进入制图。`
            : `🛑 覆盖饱和:第 ${r} 轮无新增视角/缺口/状态变化,交锋提前结束,进入制图。`)
        break
      }
      if (r < session.config.maxRounds) setProgress(session, `第 ${r}/${session.config.maxRounds} 轮完成,进入第 ${r + 1} 轮`)
      if (r === session.config.maxRounds) {
        stop = 'maxRounds'
        // 跑满细分:一方已接受(答案归一化一致,只剩记账分歧)≠ 谈崩——结论可用,直接在进度里说清。
        // 同源判据见 debate.ts isOneSidedAccept(这里只有单轮,用 rounds 拼一轮数组复用它)。
        const last = session.rounds[session.rounds.length - 1]
        const oneSided = last !== undefined && isOneSidedAccept([last], 'maxRounds')
        if (oneSided) {
          setProgress(session, `跑满 ${session.config.maxRounds} 轮:一方已接受同一答案,只剩记账分歧——结论可用,进入制图`)
        }
      }
    }
    session.stopReason = stop ?? 'maxRounds'
    setProgress(session, '交锋完成,制图员写地图中…')
    await stepSynthesize(subagents, parent, session, signal, {
      onStart: () => live.onStart('制图员写地图中…'),
      onSide: (_role, text) => {
        setProgress(session, '成果地图已出')
        // v4 收尾陈述:制图员的「决策摘要」优先;漏写则用判定数据兜底。
        // 兜底要传上限:只有 host 知道上限,猜上限等于实际轮数会把"提前收敛"误标成撞线。
        // 缺口年龄同理:从 transcript 原文现算,不猜不编;制图员写了摘要则不打扰原文。
        const decision = extractDecisionSummary(text)
        session.decisionSummary = decision !== '' ? `## ${DECISION_SECTION}\n${decision}` : buildFallbackSummary(auto.question, session.rounds, session.stopReason, session.config.maxRounds, gapSpansOf(session))
        mirror(parent, session, finalStatement(auto.question, session.decisionSummary))
      },
    })
    setProgress(session, '已完成')
    session.status = 'done'
    // 结论文档(ADR-0019):先落盘再报路径。
    // 顺序不能反——路径先说出口而文件其实没写成,比不报路径更糟。
    const rel = await writeReport(session)
    if (rel !== null) {
      mirror(parent, session, `📄 结论文档已存:\`${rel}\`\n(工作区 ${session.config.targetCwd ?? '?'};对话区这条消息会被上下文压缩,文件不会——以后直接读这个文件就能拿回全文)`)
    } else if (session.reportError !== null && session.reportError !== 'no-target-cwd') {
      mirror(parent, session, `⚠️ 结论文档没能落盘(${session.reportError});完整记录仍在辩论面板里。`)
    }
    await persist(ctx, session)
    done()
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === 'aborted')) {
      session.status = 'stopped'
      session.error = null
    } else {
      session.status = 'failed'
      session.error = err instanceof Error ? err.message : String(err)
    }
    // 失败/中止也要落盘:面板重启后还能看到"这局挂在哪",否则只剩一个丢失的 id。
    await persist(ctx, session)
    done()
  } finally {
    if (single) {
      try { await single.dispose() } catch { /* 单线回收失败不影响结果 */ }
      // 临时会话+文档存档:文档已落盘(persist 在 try/catch 里做了),分叉盘文件清掉不留。
      // 清扫失败只留痕(记 session.sweepError,面板可见),不掩盖辩论结果。
      try {
        const sweep = await sweepSingleThread(ctx, session.id)
        if (sweep.errors.length > 0) {
          session.sweepError = sweep.errors.join('; ')
        }
        session.sweptSessions = sweep.removed
      } catch (e) {
        session.sweepError = e instanceof Error ? e.message : String(e)
      }
    }
    if (pair) {
      try { await pair.dispose() } catch { /* 常驻回收失败不影响结果 */ }
    }
    if (owned) {
      try { await owned.dispose() } catch { /* 自建 parent 回收失败不影响结果 */ }
    }
  }
}
/** 子 agent 面:最小面已迁 host/types,重导出见顶。(askSubagent 已迁 host/cage。) */

/** 文本块提取:子 agent 输出的 assistant 文本。(已迁 host/cage,重导出见顶。) */

/** 辩论子 agent 工具笼(S16 白名单:只读论证员)。(已迁 host/cage,重导出见顶。) */

/** 启动核对(S16)。(已迁 host/cage,重导出见顶。) */

/** 从 schemas 原始形状里抽全局工具名。(已迁 host/cage,重导出见顶。) */

/** 笼标签(S16)。(已迁 host/cage,重导出见顶。) */

/** 执行期 guard(S16)。(已迁 host/cage,重导出见顶。) */

/**
 * 打断点(S17 会话接管):transcript 最后一条的位置,面板照此画线,不猜不编。
 * 空实录记 null(开题前就停了,没东西可指)。纯函数,可单测。
 */
export function interruptMarkOf(
  transcript: Array<{ round: number; seq: number }>,
  _round: number,
): { round: number; seq: number } | null {
  const last = transcript[transcript.length - 1]
  if (!last) return null
  return { round: last.round, seq: last.seq }
}

/**
 * 发起会话忙快照(S17 会话接管):只认 parent.status==='running',别的全算闲。
 * parent 是外部引用不落盘,落盘的是这个快照(state 暴露,面板显示"发起会话忙/闲")。
 * 形状未知(null/缺 status/别的值)一律按闲处理,不误报忙。纯函数,可单测。
 */
export function parentBusyOf(parent: unknown): boolean {
  if (parent === null || typeof parent !== 'object') return false
  return (parent as { status?: unknown }).status === 'running'
}

/**
 * 一键双停的执行计划(S17 会话接管):先停 parent turn,后 abort 后台 debate。
 * keepInbox:true 是关键——用户打断时说的那句话要留着,不清空。
 * 纯函数,可单测;IO(调 cancel/abort)在路由里。
 */
export function interruptPlanOf(_parentSid: string | null): { cancelKind: 'user'; keepInbox: true } {
  return { cancelKind: 'user', keepInbox: true }
}

/** 常驻辩手轮次卡死阈值。(与 turnVerdict/PROGRESS 一并迁 host/cage,常量重导出见顶。) */

/** 子 agent 固定 delegation 声明。(已迁 host/resident,SUBAGENT_DELEGATION_CONTEXT 重导出见顶。) */

/** 读常驻辩手自有事件。(已迁 host/resident,重导出见顶。) */

/** 工具心跳(heartbeat)。(已迁 host/resident,重导出见顶。) */

/** 文本块数组取文本(交棒结论提取用)。(已迁 host/resident,私函数随模块走。) */

/** durable stream 记录取文本。(已迁 host/resident,私函数随模块走。) */

/** 交棒结论(handoff_conclusion)提取。(已迁 host/resident,重导出见顶。) */

/** 本 epoch 最后一个 turn/end 的终端原因。(已迁 host/resident,重导出见顶。) */

/** 本 epoch 最后一个 turn/end 的终端细节。(已迁 host/resident,重导出见顶。) */

/** 常驻辩手建对。(已迁 host/resident,重导出见顶。) */

/** isRetriableTurnError/driveResidentTurn。(已迁 host/resident,重导出见顶。) */

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
/** 常驻辩手建对 + 交棒驱动。(已迁 host/resident,重导出见顶。) */

/** 取自动判断(未 resolve 抛错)。 */
function requireAuto(session: DebateSession): NonNullable<DebateConfig['auto']> {
  const auto = session.config.auto
  if (!auto) throw new Error('deliberation session not resolved: auto context missing')
  if (auto.question === '') throw new Error('empty-question: no user message found in parent session')
  return auto
}

function pushEntry(session: DebateSession, role: TranscriptEntry['role'], round: number, text: string): void {
  session.transcript.push({ seq: session.transcript.length + 1, role, round, text })
  session.updatedAt = Date.now()
  session.flush?.()
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
  // v4 焦点账本:上一轮挑战者的未决清单原样带进本轮,只谈这些。
  const focus = focusBlockOf(session)
  live?.onStart?.('builder')
  const bOut = await driveResidentTurn(pair.builder, buildBuilderRoundPrompt(auto.question, builderPrev, next, cfg.maxRounds, ctxText, focus), 'builder', signal,
    (p) => { session.streaming.builder = { round: next, kind: p.kind, text: p.text } })
  delete session.streaming.builder
  pushEntry(session, 'builder', next, bOut)
  live?.onSide?.('builder', bOut)
  live?.onStart?.('challenger')
  // 同轮内仍传对方全文:挑战者必须能逐条引用原文(否则钢人化复述无从谈起)。
  const cOut = await driveResidentTurn(pair.challenger, buildChallengerPrompt(auto.question, bOut, '', next, cfg.maxRounds, ctxText, focus), 'challenger', signal,
    (p) => { session.streaming.challenger = { round: next, kind: p.kind, text: p.text } })
  delete session.streaming.challenger
  pushEntry(session, 'challenger', next, cOut)
  live?.onSide?.('challenger', cOut)
  session.round = next
  return { round: next, builderOut: bOut, challengerOut: cOut, builderRelayChars: brief.briefChars }
}

/**
 * 单线开题:分叉会话里建构先写、挑战再写(串行,无互盲——挑战方能看到建构方原文)。
 * 驱动复用 driveResidentTurn(事件边界归因,同一会话里两段 turn 天然有序);
 * prompt 与 stepRoundResident 同形,只是载体从双会话换成单分叉。
 */
export async function stepOpenSingle(
  line: SingleThread,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ builderOpen: string; challengerOpen: string }> {
  const auto = requireAuto(session)
  const lensObjs = lensObjsOf(session)
  const ctxText = auto.context ?? ''
  const agent = line.agent
  live?.onStart?.('builder')
  const builderOpen = await driveResidentTurn(agent, buildBuilderPrompt(auto.question, lensObjs, auto.questionType, ctxText), 'builder', signal,
    (p) => { session.streaming.builder = { round: 0, kind: p.kind, text: p.text } })
  delete session.streaming.builder
  pushEntry(session, 'builder', 0, builderOpen)
  live?.onSide?.('builder', builderOpen)
  live?.onStart?.('challenger')
  // 无互盲:挑战开题直接用地建构原文(同轮全文,逐条反驳有据可依)。
  const challengerOpen = await driveResidentTurn(agent, buildChallengerPrompt(auto.question, builderOpen, '', 0, session.config.maxRounds, ctxText, ''), 'challenger', signal,
    (p) => { session.streaming.challenger = { round: 0, kind: p.kind, text: p.text } })
  delete session.streaming.challenger
  pushEntry(session, 'challenger', 0, challengerOpen)
  live?.onSide?.('challenger', challengerOpen)
  session.round = 0
  // 单线防呆豁免:同一会话单模型双角色,自报一致是必然(不是路由失效)。
  // 常驻/ one-shot 才查 isRouteIneffective(双路不同模型还报一致才是事故)。
  return { builderOpen, challengerOpen }
}

/**
 * 单线交锋一轮(串行 建构→挑战,同一分叉)。prompt 与 stepRoundResident 同形,
 * 只换载体:交棒载荷照样瘦身(ADR-0015),记忆在分叉事件流里,transcript 照落。
 */
export async function stepRoundSingle(
  line: SingleThread,
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
  const brief = prevRound === 0 ? { text: builderPrevRaw, briefChars: builderPrevRaw.length } : slimHandoff(builderPrevRaw)
  const builderPrev = brief.text
  const focus = focusBlockOf(session)
  const agent = line.agent
  live?.onStart?.('builder')
  const bOut = await driveResidentTurn(agent, buildBuilderRoundPrompt(auto.question, builderPrev, next, cfg.maxRounds, ctxText, focus), 'builder', signal,
    (p) => { session.streaming.builder = { round: next, kind: p.kind, text: p.text } })
  delete session.streaming.builder
  pushEntry(session, 'builder', next, bOut)
  live?.onSide?.('builder', bOut)
  live?.onStart?.('challenger')
  const cOut = await driveResidentTurn(agent, buildChallengerPrompt(auto.question, bOut, '', next, cfg.maxRounds, ctxText, focus), 'challenger', signal,
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
  exists?: (p: string) => boolean,
): 'convergence' | 'saturation' | null {
  const prevCombined = round === 1
    ? [lastBy(session, 'builder', 0), lastBy(session, 'challenger', 0)].join('\n\n')
    : [lastBy(session, 'builder', round - 1), lastBy(session, 'challenger', round - 1)].join('\n\n')
  const record = toDebateRound(round, builderOut, challengerOut, prevCombined, builderRelayChars, exists)
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
  // v4 焦点账本:上一轮挑战者的未决清单原样带进本轮,只谈这些。
  const focus = focusBlockOf(session)
  live?.onStart?.('builder')
  const bOut = await askSubagent(subagents, parent, session.id, 'builder', buildBuilderRoundPrompt(auto.question, builderPrev, next, cfg.maxRounds, ctxText, focus), cfg.builder, signal)
  pushEntry(session, 'builder', next, bOut)
  live?.onSide?.('builder', bOut)
  live?.onStart?.('challenger')
  const cOut = await askSubagent(subagents, parent, session.id, 'challenger', buildChallengerPrompt(auto.question, bOut, '', next, cfg.maxRounds, ctxText, focus), cfg.challenger, signal)
  pushEntry(session, 'challenger', next, cOut)
  live?.onSide?.('challenger', cOut)
  session.round = next
  return { round: next, builderOut: bOut, challengerOut: cOut, builderRelayChars: brief.briefChars }
}

/**
 * 第三步:制图(独立调用,只读实录)。返回制图原文;结构化地图暂不解析,map 返 null 占位
 * (v0.1 只产 markdown 文本,不返"四表全空"的空壳冒充解析结果)。
 */
export async function stepSynthesize(
  subagents: SubagentsLike,
  parent: ParentAgent,
  session: DebateSession,
  signal: AbortSignal,
  live?: StepLive,
): Promise<{ mapText: string; map: DebateMap | null }> {
  const cfg = session.config
  const auto = requireAuto(session)
  live?.onStart?.('synthesizer')
  const mapText = await askSubagent(subagents, parent, session.id, 'synthesizer', buildSynthesizerPrompt(auto.question, renderTranscriptForSynthesizer(session.transcript), auto.questionType), cfg.synthesizer, signal)
  pushEntry(session, 'synthesizer', cfg.maxRounds + 1, mapText)
  live?.onSide?.('synthesizer', mapText)
  // 结构化地图暂不解析:v0.1 只产 markdown 文本,map 置 null(不返空壳)。
  session.map = null
  session.mapText = mapText
  return { mapText, map: null }
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
 * 跑完整辩论循环(仅供单测:一次跑完开题+交锋+制图)。
 * 通过 ctx 上的 subagents 起 one-shot 子 agent,agentOptions 锁定模型。
 * 停机与 host 直驱同源:每轮 recordRoundAndJudge,convergence/saturation 即停,不跑满。
 */
export async function runDebateLoop(
  subagents: SubagentsLike,
  parent: ParentAgent,
  session: DebateSession,
  signal: AbortSignal,
): Promise<string> {
  await stepOpen(subagents, parent, session, signal)
  const max = session.config.maxRounds
  for (let r = 1; r <= max; r++) {
    if (signal.aborted) throw new Error('aborted')
    const { builderOut, challengerOut, builderRelayChars } = await stepRound(subagents, parent, session, signal)
    const verdict = recordRoundAndJudge(session, r, builderOut, challengerOut, builderRelayChars)
    if (verdict === 'convergence') {
      session.stopReason = 'convergence'
      break
    }
    if (verdict === 'saturation') {
      session.stopReason = 'saturation'
      break
    }
    if (r >= max) session.stopReason = 'maxRounds'
  }
  const { mapText } = await stepSynthesize(subagents, parent, session, signal)
  return mapText
}

export default {
  // tools/subagents/agents/agentPresets 必须声明 inject,否则属性读取抛错(09-24 实测根因)。
  inject: ['webServer', 'subagents', 'agents', 'agentPresets'],
  apply(ctx: Context) {
    const routes: Array<{ kind: 'exact' | 'prefix'; path: string; handler: (req: DebateHttpRequest, res: DebateHttpResponse) => void | Promise<void> }> = [
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/start',
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
            cageNote: null,
            interruptedAt: null,
            parentBusy: null,
            streaming: {},
            decisionSummary: null,
            reportRel: null,
            persistError: null,
            reportError: null,
        sweepError: null,
        sweptSessions: [],
            restored: false,
          }
          session.flush = () => schedulePersist(ctx, session)
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
          // 钳制留痕:用户填的轮数被上限压过时,第一条 progress 就明说(静默丢配置比报错更糟)。
          if (parsed.config.note !== undefined) {
            session.progress = parsed.config.note
          }
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
        path: '/dsh-session-enhance/api/version',
        handler: async (_req, res) => {
          // 版本真值:面板拿 running 显示徽标,拿 stale/reason 提示"需重启宿主"。
          // 旧进程没有这条路由(404),面板据此也能判定"后台是旧的"。
          const facts = await versionFacts()
          const verdict = assessVersions(facts)
          return writeJson(res, { ok: true, ...facts, ...verdict })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/state',
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
              maxRounds: session.config.maxRounds,
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
            cageNote: session.cageNote,
            interruptedAt: session.interruptedAt,
            parentBusy: session.parentBusy,
            streaming: session.streaming,
            decisionSummary: session.decisionSummary,
            // 持久化可观测性:结论文档路径 + 两条独立的失败原因(null=没出问题)。
            reportRel: session.reportRel,
            reportPath: session.reportRel !== null && session.config.targetCwd
              ? `${session.config.targetCwd.replace(/[\\/]+$/, '')}/${session.reportRel}`
              : null,
            persistError: session.persistError,
            reportError: session.reportError,
            restored: session.restored,
          })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/history',
        handler: async (_req, res) => {
          // 历史局一览(含磁盘恢复的):id 能被面板重新打开,unknown-id 不再是终点。
          const list = [...sessions.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 50)
            .map((s) => ({
              id: s.id,
              question: s.config.auto?.question ?? '',
              status: s.status,
              round: s.round,
              stopReason: s.stopReason,
              createdAt: s.createdAt,
              restored: s.restored,
              reportRel: s.reportRel,
              targetCwd: s.config.targetCwd ?? null,
              transcriptEntries: s.transcript.length,
            }))
          return writeJson(res, { ok: true, count: list.length, sessions: list })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/stop',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const session = sessions.get(String(body.id ?? ''))
          if (!session) return writeJson(res, { ok: false, error: 'unknown-id' })
          // v0.3:先 abort 后台任务,再兜底置 stopped(任务退出时自己会收 controllers)。
          try { controllers.get(session.id)?.abort() } catch { /* 忽略 */ }
          if (session.status === 'running') {
            // S17 打断标记:停在 transcript 哪,面板照此画线。
            session.interruptedAt = interruptMarkOf(session.transcript, session.round)
            session.status = 'stopped'
            session.updatedAt = Date.now()
            session.flush?.()
          }
          return writeJson(res, { ok: true, id: session.id, status: session.status })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/interrupt',
        handler: async (req, res) => {
          // S17 一键双停:先停 parent turn(keepInbox 留住用户刚说的话),后 abort 后台 debate。
          // 只做"停两边",不做"续跑"——续跑是下一跳,本跳只保证停得干净、transcript 可映射。
          const body = await readJsonBody(req)
          const session = sessions.get(String(body.id ?? ''))
          if (!session) return writeJson(res, { ok: false, error: 'unknown-id' })
          const plan = interruptPlanOf(session.parentSid)
          let parentStopped = false
          let parentError: string | null = null
          if (session.parentSid) {
            try {
              const agents = (ctx as unknown as { get(name: string): unknown }).get('agents') as
                | { get(id: string): { cancel?: (cause: unknown, opts?: unknown) => void } | undefined }
                | undefined
              const parent = agents?.get(session.parentSid)
              if (parent && typeof parent.cancel === 'function') {
                parent.cancel({ kind: plan.cancelKind }, { keepInbox: plan.keepInbox })
                parentStopped = true
              } else {
                parentError = parent ? 'no-cancel' : 'no-live-parent'
              }
            } catch (e) {
              parentError = e instanceof Error ? e.message : String(e)
            }
          } else {
            parentError = 'no-parent-sid'
          }
          try { controllers.get(session.id)?.abort() } catch { /* 忽略 */ }
          if (session.status === 'running') {
            session.interruptedAt = interruptMarkOf(session.transcript, session.round)
            session.status = 'stopped'
            session.updatedAt = Date.now()
            session.flush?.()
          }
          return writeJson(res, { ok: true, id: session.id, status: session.status, parentStopped, parentError })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/debug-child-tools',
        handler: async (req, res) => {
          // 真探针:起一个一次性子 agent,让它自己报手里有什么工具。
          // 读注册表只能看到 host 视角,子 agent 的真实工具集以它自己的回答为准。
          // body: { sid } (parent 会话 id;不传则用第一个活体;无活体则自建满血 parent)。
          // 零业务成本:只问工具表,不跑辩论。自建 parent 用完即 dispose。
          // S16 带笼模式:body.caged=true 时挂辩手白名单起,子 agent 报的是笼内视角
          // (辩论结论"先跑一次带笼探针定出最小工具集"的落点);不传则裸起(全量对照)。
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
              const full = await createFullParent(ctx, agents, `se-probe-${Date.now().toString(36)}`, DEFAULT_CONFIG.synthesizer, AbortSignal.timeout(180000))
              owned = { dispose: full.dispose }
              parent = full.agent
              selfBuilt = true
              presetId = full.presetId
            }
            if (!parent || !parent.session) return writeJson(res, { ok: false, error: 'no live parent' })
            const ctl = new AbortController()
            const timer = setTimeout(() => ctl.abort(), 120000)
            const caged = (body as { caged?: unknown }).caged === true
            try {
              const run = await subagents.start('spawn', {
                parent,
                prompt: [{
                  type: 'text',
                  text: '你是工具盘点员。只做一件事:列出你当前能调用的所有工具名,一行一个,不要解释,不要调用任何工具,不要输出别的。',
                } as TextContentBlock],
                label: 'se-debug-child-tools',
                signal: ctl.signal,
                ...(caged ? { toolFilter: { allow: DEBATER_TOOL_ALLOW } } : {}),
              })
              try {
                const result = await run.result
                return writeJson(res, {
                  ok: true,
                  parentSid: parent.session.id,
                  selfBuilt,
                  presetId,
                  caged,
                  cage: caged ? cageLabel(DEBATER_TOOL_ALLOW, []) : null,
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
        path: '/dsh-session-enhance/api/debug',
        handler: async (_req, res) => {
          // 自检:host 视角的工具表(curl 即判,不用进 GUI)。本插件不注册任何模型工具。
          try {
            const tools = (ctx as unknown as { get(name: string): unknown }).get('tools') as { schemas?: (scope?: unknown) => Array<{ name?: unknown }> } | undefined
            const all = tools?.schemas?.() ?? []
            const names = all.map((t) => t.name).filter((n): n is string => typeof n === 'string')
            return writeJson(res, { ok: true, tools: names })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/debug-agent',
        handler: async (req, res) => {
          // 自检:host 能否按 sid 拿到活体 parent(零模型成本,不起子 agent)。
          // 不传 sid 则列出所有活体 agent id,供 curl 探针取一个真实 sid 跑全链路。
          // 传 sid 则加报 parent 的 composition(preset/cwd):子 agent 继承 parent 的 preset 再收窄,parent 残则子必残。
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
        path: '/dsh-session-enhance/api/debug-sessions',
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
                reportRel: s.reportRel,
                persistError: s.persistError,
                reportError: s.reportError,
                restored: s.restored,
              })
            }
            return writeJson(res, { ok: true, count: list.length, sessions: list })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/debug-followup',
        handler: async (req, res) => {
          // T1 探针 P1(一次性,有副作用):对 parent 真调一次 followup,看发起会话
          // 是否起 turn。只发一条无害心跳文本,不跑模型任务,随时可停。
          // body: { sid?, debateId?, text? }。sid 直给发起会话 id;debateId 则从
          // debate 会话表取 parentSid(面板点按钮用,不用用户找会话 id)。
          // 返回 followup 前后 status 快照 + 3s 后的 status。
          // 用户侧观察:发送按钮是否变停止、有无"深度求索中"蓝字。
          try {
            const body = await readJsonBody(req)
            const agents = ctx.get('agents') as {
              get(id: string): {
                followup?: (input: unknown) => void
                whenIdle?: () => Promise<void>
                status?: unknown
                session?: { id: string }
              } | undefined
              list(): Array<{ session?: { id: string } }>
            } | undefined
            if (!agents) return writeJson(res, { ok: false, error: 'agents service unavailable' })
            const sid = typeof body.sid === 'string' ? body.sid : ''
            const debateId = typeof body.debateId === 'string' ? body.debateId : ''
            const fromDebate = debateId !== '' ? sessions.get(debateId)?.parentSid ?? '' : ''
            const live = agents.list().map((a) => a.session?.id ?? '?')
            const target = sid !== '' ? sid : fromDebate !== '' ? fromDebate : (live[0] ?? '')
            if (target === '' || target === '?') return writeJson(res, { ok: true, live, resolved: false })
            const parent = agents.get(target)
            if (!parent || typeof parent.followup !== 'function') {
              return writeJson(res, { ok: true, live, resolved: false, reason: 'no-followup' })
            }
            const statusBefore = typeof parent.status === 'string' ? parent.status : String(parent.status)
            const text = typeof body.text === 'string' && body.text !== ''
              ? body.text
              : '【探针】前台占位 turn 测试：这是一条无害心跳，看到请告诉我会话区是否进入运行态。'
            parent.followup({
              id: `se-probe-${Date.now().toString(36)}`,
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            })
            await new Promise((r) => setTimeout(r, 3000))
            const statusAfter = typeof parent.status === 'string' ? parent.status : String(parent.status)
            return writeJson(res, { ok: true, live, resolved: true, sid: target, statusBefore, statusAfter })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/debug-parent',
        handler: async (req, res) => {
          // T1 探针 P0(只读,零副作用):host 如实上报 parent 对象上有哪些可用方法。
          // 不调用 followup,不起 turn,只枚举能力,决定 P1 是否值得动手。
          // body: { sid } (发起会话 id;不传则取第一个活体)。
          try {
            const body = await readJsonBody(req)
            const agents = ctx.get('agents') as {
              get(id: string): Record<string, unknown> | undefined
              list(): Array<{ session?: { id: string } }>
            } | undefined
            if (!agents) return writeJson(res, { ok: false, error: 'agents service unavailable' })
            const sid = typeof body.sid === 'string' ? body.sid : ''
            const live = agents.list().map((a) => a.session?.id ?? '?')
            const target = sid !== '' ? sid : (live[0] ?? '')
            if (target === '' || target === '?') return writeJson(res, { ok: true, live, resolved: false })
            const parent = agents.get(target)
            if (!parent) return writeJson(res, { ok: true, live, resolved: false })
            const keys = Object.keys(parent).sort()
            const cap: Record<string, string> = {}
            for (const k of ['followup', 'cancel', 'whenIdle', 'status', 'dispose', 'session', 'ctx']) {
              const v = (parent as Record<string, unknown>)[k]
              cap[k] = typeof v + (typeof v === 'function' ? `(${String(v).slice(0, 80)})` : '')
            }
            const sess = (parent as Record<string, unknown>).session as Record<string, unknown> | undefined
            const sessKeys = sess ? Object.keys(sess).sort() : []
            return writeJson(res, { ok: true, live, resolved: true, sid: target, keys, cap, sessKeys })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      // ── 跨仓任务(task)路由(ADR-0025):scan/build/launch/report/collect/stop
      // + recommend(ADR-0028:按任务描述推荐涉及仓,模型只给推荐、人审核)。
      // 全部参数显式,不从调用会话 cwd 推导;模板真身仍在各编排库(templateDir/模板文本显式传)。
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/version',
        handler: async (_req, res) => {
          const facts = await versionFacts()
          return writeJson(res, { ok: true, version: BUILD_VERSION, ...facts })
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/recommend',
        handler: async (req, res) => {
          // 涉及仓推荐(ADR-0028):按任务描述从扫描到的仓里挑涉及仓。
          // 模型只给推荐 + 理由 + 简短标题,面板预勾选后必须经用户审核;
          // 判不出/调用失败一律 ok:false,面板回退空选 + 提示手勾,不阻塞。
          let owned: { dispose(): Promise<void> } | null = null
          try {
            const body = await readJsonBody(req)
            const description = typeof body.description === 'string' ? body.description.trim() : ''
            const repos = Array.isArray(body.repos) ? body.repos as Array<Record<string, unknown>> : []
            if (description === '') return writeJson(res, { ok: false, error: 'description required' })
            if (repos.length === 0) return writeJson(res, { ok: false, error: 'repos required' })
            const known = repos
              .filter((r) => (r.kind === 'repo' || r.kind === 'part') && typeof r.relPath === 'string')
              .map((r) => ({ relPath: String(r.relPath), kind: String(r.kind) }))
            for (const r of known) assertTaskAscii(r.relPath, 'repos[].relPath')
            if (known.length === 0) return writeJson(res, { ok: false, error: 'no recommendable repos' })
            const agents = ctx.get('agents') as AgentsLike | undefined
            const subagents = ctx.get('subagents') as SubagentsLike | undefined
            if (!agents || !subagents) return writeJson(res, { ok: false, error: 'agents/subagents unavailable' })
            const sid = typeof body.sid === 'string' ? body.sid : ''
            // parent 三段式(照抄 runHostDebate):sid 直取 → 兜底活体 → 自建满血。
            // fake ctx 下 agents 可能缺 get/list,全程 try 兜底,最终走自建。
            let parent: ParentAgent | undefined
            if (sid !== '') {
              try {
                const got = (agents as AgentsLike | undefined)?.get(sid) as ParentAgent | undefined
                if (got?.session) parent = got
              } catch { /* 取不到走兜底 */ }
            }
            if (!parent?.session && agents) {
              try {
                const live = (agents as AgentsLike).list() ?? []
                const first = live.find((a) => (((a as unknown) as ParentAgent)?.session?.id)) as ParentAgent | undefined
                if (first?.session) parent = first
              } catch { /* 兜底失败则走自建 */ }
            }
            if (!parent || !parent.session) {
              const full = await createFullParent(ctx, agents, `se-recommend-${Date.now().toString(36)}`, DEFAULT_CONFIG.synthesizer, AbortSignal.timeout(180000))
              owned = { dispose: full.dispose }
              parent = full.agent
            }
            if (!parent || !parent.session) return writeJson(res, { ok: false, error: 'no live parent' })
            const list = known.map((r) => `- ${r.relPath} (${r.kind})`).join('\n')
            const prompt = [
              '你是分仓员。只做一件事：按下面的任务描述，从候选仓里挑出本次任务涉及的仓。',
              '只输出一段 JSON，不要解释，不要调用任何工具，不要输出别的：',
              '{"recommended": ["仓路径1", ...], "reasons": {"仓路径1": "一句话理由", ...}, "title": "任务简短标题(20字内)"}',
              '规则：recommended 只从候选里选，按相关度由高到低排；判不出就给空数组；title 是给人看的一句话。',
              '',
              '任务描述：',
              description,
              '',
              '候选仓：',
              list,
            ].join('\n')
            const ctl = new AbortController()
            const timer = setTimeout(() => ctl.abort(), 120000)
            try {
              const run = await subagents.start('spawn', {
                parent,
                prompt: [{ type: 'text', text: prompt } as TextContentBlock],
                label: 'se-task-recommend',
                signal: ctl.signal,
              })
              try {
                const result = await run.result
                const raw = textOf(result.output)
                if (result.stopReason !== 'completed') {
                  return writeJson(res, { ok: false, error: `recommend subagent: ${result.stopReason}`, stopReason: result.stopReason, rawLen: raw.length, rawHead: raw.slice(0, 200) })
                }
                const cleaned = parseRecommendText(raw, known)
                return writeJson(res, { ok: true, ...cleaned, stopReason: result.stopReason, rawLen: raw.length })
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
              try { await owned.dispose() } catch { /* 自建 parent 回收失败不影响结果 */ }
            }
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/scan',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const parentRoot = body.parentRoot
            if (typeof parentRoot !== 'string' || parentRoot === '') throw new Error('parentRoot required')
            assertTaskAscii(parentRoot, 'parentRoot')
            const externalNames = Array.isArray(body.externalNames) ? body.externalNames as string[] : undefined
            const out = await scanParent(parentRoot as string, taskDefaultDeps(), externalNames ? { externalNames } : {})
            return writeJson(res, { ok: true, ...out })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/build',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const { slug, title, tasksRoot, baselines, parentRoot: bodyParentRoot } = body as Record<string, unknown>
            const involved = (body as Record<string, unknown>).involved
            if (typeof slug !== 'string' || slug === '') throw new Error('slug required')
            if (!Array.isArray(involved) || involved.length === 0) throw new Error('involved required')
            if (typeof tasksRoot !== 'string' || tasksRoot === '') throw new Error('tasksRoot required')
            assertTaskAscii(slug, 'slug')
            assertTaskAscii(tasksRoot as string, 'tasksRoot')
            for (const repo of involved as unknown[]) assertTaskAscii(String(repo), 'involved[]')
            // parentRoot 显式给出时即验 involved 落点存在(路径映射错第一时间暴露,
            // 不等到 launch 才发现拉错仓);不给则不验。skipInvolvedCheck 显式绕过(测试用)。
            if (!(body as Record<string, unknown>).skipInvolvedCheck
              && typeof bodyParentRoot === 'string' && bodyParentRoot !== '') {
              assertTaskAscii(bodyParentRoot, 'parentRoot')
              const missing = [...(involved as unknown[]).map(String)]
                .filter((r, i, a) => a.indexOf(r) === i)
                .map((r) => ({ repo: r, cwd: path.join(bodyParentRoot, ...r.split('/')) }))
                .filter(({ cwd }) => {
                  try {
                    return !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()
                  } catch { return false }
                })
                .map(({ repo }) => repo)
              if (missing.length > 0) {
                throw new Error(`involved not found under parentRoot ${bodyParentRoot}: ${missing.join(', ')}`)
              }
            }
            // 同秒重调(时间戳唯一):先定唯一 stamp 再渲染材料,version 与目录名同源不錯位。
            // fs/path 走顶部静态导入(ESM 构建,禁用动态 require)。
            let stamp = taskStampOf()
            const tRoot = tasksRoot as string
            for (let bump = 0; bump < 60 && fs.existsSync(path.join(tRoot, `${slug as string}-${stamp}`)); bump++) {
              stamp = taskStampOf(Date.now() + (bump + 1) * 1000)
            }
            const taskDirName = `${slug as string}-${stamp}`
            const taskDir = path.join(tRoot, taskDirName)
            if (fs.existsSync(taskDir)) throw new Error(`task dir collision under ${tRoot} for slug ${slug as string}`)
            const created = taskCreatedOf()
            // 模板真身在编排库:调用方显式传 templateDir,或显式传 directiveTemplate/toTemplate 文本覆盖文件读取;
            // 都不传才回退 tasksRoot 上一级,回退路径仍做 ASCII 门。
            const bodyRec = body as Record<string, unknown>
            let directiveTemplate = typeof bodyRec.directiveTemplate === 'string' ? bodyRec.directiveTemplate : null
            let toTemplate = typeof bodyRec.toTemplate === 'string' ? bodyRec.toTemplate : null
            if (!directiveTemplate || !toTemplate) {
              const templateDir = typeof bodyRec.templateDir === 'string' && bodyRec.templateDir !== ''
                ? bodyRec.templateDir
                : path.resolve(tRoot, '..')
              assertTaskAscii(templateDir, 'templateDir')
              directiveTemplate = directiveTemplate ?? fs.readFileSync(path.join(templateDir, 'directive_template.md'), 'utf-8')
              toTemplate = toTemplate ?? fs.readFileSync(path.join(templateDir, 'to_template.md'), 'utf-8')
            }
            const baseline = typeof baselines === 'string' ? baselines
              : (baselines !== null && typeof baselines === 'object' && typeof (baselines as Record<string, unknown>).catalog === 'string'
                ? (baselines as Record<string, unknown>).catalog as string : '<基线由调用方填>')
            const out = buildMaterials({
              slug: slug as string, stamp, involved: (involved as unknown[]).map(String),
              title: typeof title === 'string' && title !== '' ? title : (slug as string),
              baseline, created,
              directiveTemplate: directiveTemplate as string, toTemplate: toTemplate as string,
            })
            // 占位残留断言:模板没填完就报错,不写半成品目录。
            const leftover = [...leftoverPlaceholders(out.directive), ...out.toFiles.flatMap((f) => leftoverPlaceholders(f.text))]
            if (leftover.length > 0) throw new Error(`template placeholders unfilled: ${[...new Set(leftover)].slice(0, 5).join(', ')}`)
            fs.mkdirSync(taskDir, { recursive: true })
            fs.writeFileSync(path.join(taskDir, 'directive.md'), out.directive, 'utf-8')
            for (const f of out.toFiles) fs.writeFileSync(path.join(taskDir, f.fileName), f.text, 'utf-8')
            return writeJson(res, { ok: true, taskDir, taskDirName: out.taskDirName, files: ['directive.md', ...out.toFiles.map((f) => f.fileName)] })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/launch',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const { taskDir, parentRoot } = body as Record<string, unknown>
            const involved = (body as Record<string, unknown>).involved
            if (typeof taskDir !== 'string' || taskDir === '') throw new Error('taskDir required')
            if (!Array.isArray(involved) || involved.length === 0) throw new Error('involved required')
            if (typeof parentRoot !== 'string' || parentRoot === '') throw new Error('parentRoot required')
            assertTaskAscii(taskDir, 'taskDir')
            assertTaskAscii(parentRoot, 'parentRoot')
            for (const repo of involved as unknown[]) assertTaskAscii(String(repo), 'involved[]')
            // issued 后才调:directive 状态非 issued 直接拒收,不拉空模板会话。
            // 显式传 skipIssuedCheck:true 可绕过(测试/探针用)。
            if (!(body as Record<string, unknown>).skipIssuedCheck) {
              // fs 走顶部静态导入。
              let directiveText = ''
              try {
                directiveText = fs.readFileSync(path.join(taskDir, 'directive.md'), 'utf-8')
              } catch {
                throw new Error('directive.md not found under taskDir (build first?)')
              }
              if (!/^status:\s*issued\b/m.test(directiveText)) {
                throw new Error('directive not issued (fill it and flip status: draft → issued first)')
              }
            }
            const agents = ctx.get('agents') as { create(o: unknown): Promise<{ agent?: { followup?: (m: unknown) => void } }> } | undefined
            if (!agents) throw new Error('agents unavailable')
            const bodyRec = body as Record<string, unknown>
            const provider = typeof bodyRec.provider === 'string' && bodyRec.provider !== '' ? bodyRec.provider : undefined
            const model = typeof bodyRec.model === 'string' && bodyRec.model !== '' ? bodyRec.model : undefined
            const taskRef = taskDir.replace(/\\/g, '/')
            const sessions: Array<Record<string, unknown>> = []
            for (const repo of (involved as unknown[]).map(String)) {
              const ctl = new AbortController()
              const key = `${taskDir}::${repo}::${Date.now()}`
              taskLaunchControllers.set(key, ctl)
              try {
                const cwd = path.join(parentRoot, ...repo.split('/'))
                const text = handoffText(taskRef, repo)
                if (ctl.signal.aborted) throw new Error('aborted')
                const out = await ensureGroupedSession(
                  { get: ctx.get.bind(ctx) as (name: string) => unknown, agents: agents as never },
                  { cwd, text, signal: ctl.signal, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
                )
                sessions.push({ repo, ok: true, ...out })
              } catch (e) {
                sessions.push({ repo, ok: false, error: e instanceof Error ? e.message : String(e) })
              } finally {
                taskLaunchControllers.delete(key)
              }
            }
            return writeJson(res, { ok: true, sessions, taskDir })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/report',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const { taskDir, from } = body as Record<string, unknown>
            if (typeof taskDir !== 'string' || taskDir === '') throw new Error('taskDir required')
            if (typeof from !== 'string' || from === '') throw new Error('from required')
            assertTaskAscii(taskDir, 'taskDir')
            assertTaskAscii(from, 'from')
            const bodyRec = body as Record<string, unknown>
            const fileName = reportFileName(from)
            const md = reportMarkdown({
              from,
              to: typeof bodyRec.to === 'string' ? bodyRec.to : undefined,
              slug: typeof bodyRec.slug === 'string' ? bodyRec.slug : '',
              ticket: typeof bodyRec.ticket === 'string' ? bodyRec.ticket : '',
              created: taskCreatedOf(),
              stuck: typeof bodyRec.stuck === 'string' ? bodyRec.stuck : '',
              change: typeof bodyRec.change === 'string' ? bodyRec.change : '',
              paths: Array.isArray(bodyRec.paths) ? (bodyRec.paths as unknown[]).map(String) : [],
            })
            const outPath = path.join(taskDir, fileName)
            fs.writeFileSync(outPath, md, 'utf-8')
            return writeJson(res, { ok: true, path: outPath })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/collect',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const { taskDir } = body as Record<string, unknown>
            if (typeof taskDir !== 'string' || taskDir === '') throw new Error('taskDir required')
            assertTaskAscii(taskDir, 'taskDir')
            const names = fs.readdirSync(taskDir).filter((n) => n.startsWith('back-') && n.endsWith('.md')).sort()
            const backs = names.map((n) => ({ file: n, text: fs.readFileSync(path.join(taskDir, n), 'utf-8') }))
            return writeJson(res, { ok: true, backs })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-session-enhance/api/task/stop',
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const ids = (body as Record<string, unknown>).ids
            let stopped = 0
            if (Array.isArray(ids) && ids.length > 0) {
              for (const id of ids.map(String)) {
                const ctl = taskLaunchControllers.get(id)
                if (ctl) { try { ctl.abort() } catch { /* 忽略 */ } taskLaunchControllers.delete(id); stopped++ }
              }
            } else {
              for (const ctl of taskLaunchControllers.values()) {
                try { ctl.abort() } catch { /* 忽略 */ } stopped++
              }
              taskLaunchControllers.clear()
            }
            clearTaskTempHandles()
            return writeJson(res, { ok: true, stopped })
          } catch (e) {
            return writeJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
    ]
    // 真实 webServer.register 只接受单个 route(数组会被静默塞进前缀表导致路由失效,见 explorer 经验)
    for (const route of routes) ctx.webServer.register(route)

    // 装载上一进程留下的局(ADR-0019)。后台做,不挡路由注册:
    // 面板在装载完成前轮询旧 id 会拿到一次 unknown-id,那是可接受的过渡态。
    void loadPersisted(ctx)
    // HMR 重载插件时(profile 的模块监听是可选项)必须关掉 KV 单元:
    // 同一个单元名未关就再开是调用方 bug,后端会直接 reject,那会让重载后的插件彻底没有持久化。
    // 用 ctx.effect 而不是 ctx.on('dispose'):cordis 4 的清理钩子是 effect 返回的 disposer。
    ctx.effect(() => () => {
      const unit = store
      store = null
      storeTried = false
      if (unit !== null) void unit.close().catch(() => { /* 关闭失败无补救,进程反正要走了 */ })
    })

    // 模型工具:无。人工操作插件,不注册任何模型工具(host 直驱走 subagents 服务)。
  },
}
