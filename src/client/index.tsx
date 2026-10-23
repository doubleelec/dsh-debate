/**
 * dsh-session-enhance — Client 半区。
 *
 * 只用按钮,不用命令:输入框 input.right「✦ 增强」菜单(辩论/多仓任务二选一)+
 * shell.overlay 浮层对话框(辩论 Dialog:三模型+轮数,问题/题型/lens 自动判断;任务 TaskDialog 三步)。
 * 建单走 /dsh-session-enhance/api/start,轮询 /dsh-session-enhance/api/state 取实况。
 * 执行由 host 后台直驱完成(ADR-0011,面板点开始即跑,不发触发语)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './panel.module.css'
import { BUILD_VERSION, isClientStale } from '../version'

/** /api/version 响应:host 报的"我真正在跑的版本" + 与磁盘的对账结论。 */
interface VersionResp {
  ok?: boolean
  running?: string
  disk?: string | null
  stale?: boolean
  reason?: string | null
}
import { splitSections } from './sections'
import { resolveSessionId } from './session'
import { roleName, roundLabel, roundSummary, stopKey } from './labels'
import {
  suggestTasksRoot, validateTaskBuild,
  loadTaskPrefs, saveTaskPrefs, defaultParentRoot, suggestScanDefaults,
  suggestSlugFromText,
  applyRecommendDefaults,
} from './task'
import {
  DIALOG_DEFAULT_H, DIALOG_DEFAULT_W,
  clampDialogHeight, clampDialogWidth, clampStoredHeight, clampStoredWidth,
  loadManualHeight, loadManualWidth, saveManualHeight, saveManualWidth,
} from './dialogLayout'

const C = (k: string): string => styles[k] ?? k

// ---------- 与 Host 的 JSON RPC ----------
// 先读 text 再 JSON.parse:host 路由抛错时框架可能回非 JSON(HTML 错误页),
// res.json() 直接炸成 SyntaxError,连路由的 ok:false 都看不到。text 透出原文头。
async function api<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/dsh-session-enhance/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`HTTP ${res.status}:非 JSON 响应(路由可能抛错):${text.slice(0, 200)}`)
  }
}

// ---------- 国际化 ----------
const NS = 'dsh-session-enhance'
const DICTS: Record<string, Record<string, string>> = {
  zh: {
    'panel.title': '开放辩论', 'tip': '为开放性问题跑建构 / 挑战 / 制图,产出成果地图',
    'auto.note': '问题、题型、视角、背景自动从当前会话提取,不用填。',
    'auto.question': '问题:', 'auto.type': '题型:', 'auto.lensesUnit': ' 个视角', 'auto.ctx': '背景 ', 'auto.charsUnit': ' 字',
    'type.selection': '选型 / 方案比较', 'type.review': '评审 / 对照验证',
    'type.tradeoff': '权衡 / 决策', 'type.causal': '因果 / 解释',
    'builder.label': '建构者模型', 'challenger.label': '挑战者模型', 'synth.label': '制图员模型',
    'rounds.label': '最大轮数',
    'stop.convergence': '共识收敛停机', 'stop.convergenceCap': '压线共识停机(谈满上限轮才一致)', 'stop.saturation': '覆盖饱和停机', 'stop.maxRounds': '跑满停机',
    'stop.manual': '手动提前制图', 'stop.pending': '判定中…',
    'audit.title': '停机审计', 'audit.quoted': '引用', 'audit.relay': '交棒',
    'mirror.off': '仅面板(自建 parent,无对话区可写)',
    'mirror.on': '对话区镜像', 'mirror.fail': '镜像失败',
    'interrupt.mark': '⛔ 此处被打断(后续实录是停机前已写完的,之后无新增)',
    'btn.start': '开始辩论', 'btn.stop': '停止', 'btn.close': '关闭',
    'btn.interrupt': '一键双停', 'btn.interruptTip': '连发起会话的 turn 一起停(用户刚说的话留着),后台辩论同步中止',
    'st.idle': '就绪', 'st.running': '辩论进行中…(host 后台直驱,开题/交锋/地图自动进面板)',
    'st.polling': '等待模型执行…', 'st.done': '已完成', 'st.failed': '失败', 'st.stopped': '已停止',
    'draft.hint': '跑完后可复制成果地图回输入框',
    'trigger.copy': '复制成果地图', 'trigger.copied': '已复制,去输入框粘贴',
    'map.lenses': '视角清单', 'map.args': '论证表', 'map.grounding': '依据表',
    'map.disputes': '分歧地图', 'map.gaps': '缺口清单',
    'settings.nav': '会话增强', 'settings.note': '默认模型与轮数(面板每次可改)。',
    'version': '版本 v{ver}',
    'btn.fullscreen': '全屏', 'btn.unfullscreen': '退出全屏', 'btn.minimize': '最小化',
    'btn.restore': '恢复', 'resize.tip': '右下角拖拽调整大小,双击恢复默认',
    'minimized.running': '辩论进行中…', 'minimized.done': '辩论已结束',
    'role.builder': '建构方', 'role.challenger': '挑战方', 'role.synthesizer': '制图员',
    'round.opening': '开题', 'round.map': '成果地图', 'round.n': '第{n}轮',
    'stream.writing': '正在写…', 'stream.tools': '正在调工具…',
    'audit.quoted.tip': '本轮引用对方原文的行数 / 可引用的行数',
    'audit.relay.tip': '建构方给挑战方的交棒摘要长度',
    'audit.new': '有新料', 'audit.nonew': '本轮没新料',
    'audit.ptr': '出处{hit}/{total}', 'audit.ptrMissing': '缺:{missing}', 'audit.ptrUnverified': '验不了{n}条',
    'audit.ptr.tip': '本轮文件型出处指针的存在命中(相对目标工作区验,只审计不停机)',
    'summary.title': '轮次小结',
    'summary.agreeBoth': '双方达成一致「{answer}」',
    'summary.builderAccepts': '建构方接受了挑战方的「{answer}」',
    'summary.challengerAccepts': '挑战方接受了建构方的「{answer}」',
    'summary.standoff': '建构方坚持「{b}」,挑战方坚持「{c}」',
    'summary.opening': '开题:建构方摆出「{b}」,挑战方摆出「{c}」',
    'summary.quoted': '引用对方{q}/{t}行',
    'decision.title': '辩论结论(可直接回填到输入框)',
    'decision.copy': '回填到输入框',
    'summary.pending': '未决{n}条',
    'ver.tip': '后台(实际在跑)v{host} · 界面 v{client} · 磁盘 v{disk}',
    'ver.warnTitle': '版本不一致',
    'ver.unknown': '取不到后台版本:这个宿主没有版本接口(通常是改完代码没重启宿主)。徽标显示 v? 而不是假装是新版本。重启宿主后此处会显示真实版本。',
    'ver.unknownTip': '后台版本未知(宿主未重启或接口不可用)',
    'ver.hostStale': '{reason}',
    'ver.clientStale': '浏览器还在用旧界面(v{client}),后台已经是 v{host}:强制刷新页面(Ctrl+Shift+R)即可,不用重启宿主。',
    'report.saved': '结论文档:',
    'report.copy': '复制路径',
    'report.warnTitle': '持久化异常',
    'report.persistFail': '整局记录没能落盘({err}):宿主重启后这局的 id 会失效。',
    'report.fileFail': '结论文档没能写入({err}):辩论结论本身没问题,完整记录仍在下方与整局记录里。',
    'report.noCwd': '没有目标工作区,结论文档没地方落盘(整局记录仍在)。填「目标」或从会话工作区发起即可。',
    'report.restored': '本局是从磁盘恢复的(宿主重启前的记录):结论可读,但不会再继续跑。',
  },
  en: {
    'panel.title': 'Deliberation', 'tip': 'Builder / challenger / synthesizer map for open questions',
    'auto.note': 'Question, type, lenses and context are auto-extracted from this session.',
    'auto.question': 'Q: ', 'auto.type': 'Type: ', 'auto.lensesUnit': ' lenses', 'auto.ctx': 'ctx ', 'auto.charsUnit': ' chars',
    'type.selection': 'Selection / comparison', 'type.review': 'Review / verification',
    'type.tradeoff': 'Tradeoff / decision', 'type.causal': 'Causal / explanation',
    'builder.label': 'Builder model', 'challenger.label': 'Challenger model', 'synth.label': 'Synthesizer model',
    'rounds.label': 'Max rounds',
    'stop.convergence': 'stopped: convergence', 'stop.convergenceCap': 'stopped: convergence at cap (agreed only on the last allowed round)', 'stop.saturation': 'stopped: saturation', 'stop.maxRounds': 'stopped: max rounds',
    'stop.manual': 'manual map', 'stop.pending': 'judging…',
    'audit.title': 'Stop audit', 'audit.quoted': 'quoted', 'audit.relay': 'relay',
    'mirror.off': 'panel only (self-built parent, no chat surface)',
    'mirror.on': 'chat mirror', 'mirror.fail': 'mirror failed',
    'interrupt.mark': '⛔ interrupted here (entries below were finished before stop, nothing after)',
    'btn.start': 'Start debate', 'btn.stop': 'Stop', 'btn.close': 'Close',
    'btn.interrupt': 'Interrupt both', 'btn.interruptTip': 'Stop the parent turn too (keep what the user just said), abort the background debate',
    'st.idle': 'Ready', 'st.running': 'Deliberation running… (host drives open → rounds → map into the panel)',
    'st.polling': 'Waiting for model…', 'st.done': 'Done', 'st.failed': 'Failed', 'st.stopped': 'Stopped',
    'draft.hint': 'Copy the result map back to the composer when done',
    'trigger.copy': 'Copy result map', 'trigger.copied': 'Copied — paste in composer',
    'map.lenses': 'Lenses', 'map.args': 'Arguments', 'map.grounding': 'Grounding',
    'map.disputes': 'Disputes', 'map.gaps': 'Gaps',
    'settings.nav': 'Session Enhance', 'settings.note': 'Default models and rounds (overridable per run).',
    'version': 'Version v{ver}',
    'btn.fullscreen': 'Fullscreen', 'btn.unfullscreen': 'Exit fullscreen', 'btn.minimize': 'Minimize',
    'btn.restore': 'Restore', 'resize.tip': 'Drag from the corner to resize, double-click to reset',
    'minimized.running': 'Deliberation running…', 'minimized.done': 'Deliberation finished',
    'role.builder': 'Builder', 'role.challenger': 'Challenger', 'role.synthesizer': 'Synthesizer',
    'round.opening': 'Opening', 'round.map': 'Result map', 'round.n': 'Round {n}',
    'stream.writing': 'writing…', 'stream.tools': 'calling tools…',
    'audit.quoted.tip': 'Quoted lines from the other side / quotable lines',
    'audit.relay.tip': 'Handoff summary length from builder to challenger',
    'audit.new': 'new info', 'audit.nonew': 'no new info this round',
    'audit.ptr': 'refs {hit}/{total}', 'audit.ptrMissing': 'missing:{missing}', 'audit.ptrUnverified': '{n} unverifiable',
    'audit.ptr.tip': 'File-pointer existence hits this round (checked against target cwd, audit only)',
    'summary.title': 'Round summaries',
    'summary.agreeBoth': 'Both sides agree on "{answer}"',
    'summary.builderAccepts': 'Builder accepts challenger\'s "{answer}"',
    'summary.challengerAccepts': 'Challenger accepts builder\'s "{answer}"',
    'summary.standoff': 'Builder holds "{b}", challenger holds "{c}"',
    'summary.opening': 'Opening: builder argues "{b}", challenger argues "{c}"',
    'summary.quoted': 'quoted {q}/{t} lines',
    'decision.title': 'Deliberation conclusion (paste-ready)',
    'decision.copy': 'Send to composer',
    'summary.pending': '{n} open',
    'ver.tip': 'backend (running) v{host} · UI v{client} · disk v{disk}',
    'ver.warnTitle': 'Version mismatch',
    'ver.unknown': 'Cannot read the backend version: this host has no version endpoint, which usually means the code was rebuilt but the host was not restarted. The badge shows v? instead of pretending to be current; restart the host to see the real version.',
    'ver.unknownTip': 'Backend version unknown (host not restarted, or endpoint unavailable)',
    'ver.hostStale': '{reason}',
    'ver.clientStale': 'The browser still runs the old UI (v{client}) while the backend is v{host}: hard-refresh (Ctrl+Shift+R); no host restart needed.',
    'report.saved': 'Conclusion file:',
    'report.copy': 'Copy path',
    'report.warnTitle': 'Persistence problem',
    'report.persistFail': 'The session record was not persisted ({err}): this id will not resolve after a host restart.',
    'report.fileFail': 'The conclusion file was not written ({err}): the debate itself is fine, the full record stays below and in the session record.',
    'report.noCwd': 'No target workspace, so the conclusion file has nowhere to land (the session record is still kept). Set a target or start from a session workspace.',
    'report.restored': 'Restored from disk (recorded before the host restarted): the conclusion is readable, but this debate will not continue.',
  },
}

// ---------- 题型名仅用于展示自动判断结果(分类由 host 的 classifyQuestion 定) ----------
// v0.1 模型下拉:先给 local-proxy 现有池,插件版设置页可扩展。
const MODELS = [
  { provider: 'local-proxy', model: 'opencode-muse-spark-1.3' },
  { provider: 'local-proxy', model: 'ds4-flash-nothink' },
  { provider: 'local-proxy', model: 'opencode-ds41-flash' },
  { provider: 'local-proxy', model: 'auto-adaptive' },
  { provider: 'local-proxy', model: 'free-auto' },
]

interface Turn { seq: number; role: string; round: number; text: string }
interface RoundAudit {
  round: number
  builderAnswer: string
  builderAgree: boolean
  challengerAnswer: string
  challengerAgree: boolean
  hasNewInfo: boolean
  builderRelayChars: number
  protoVersion: number
  /** v4 焦点账本:挑战者本轮自报的未决条件(null=没提供,[]=已清零)。 */
  pendingItems?: string[] | null
  quoteAudit: { quotableLines: number; quotedLines: number; hitLines: number[]; hitRate: number | null }
  /** 出处指针审计(null=无文件型指针/老局没验,只审计不 gate)。 */
  pointerAudit?: { total: number; hit: number; missing: string[]; unverified: string[] } | null
}
interface AutoResolved { question: string; questionType: string; lenses: number; contextChars: number; targetCwd?: string | null; maxRounds?: number }
interface StateResp {
  ok: boolean
  id?: string
  status?: string
  round?: number
  transcript?: Turn[]
  auto?: AutoResolved
  map?: unknown
  mapText?: string | null
  error?: string
  progress?: string
  mirrorCount?: number
  mirrorError?: string | null
  parentSid?: string | null
  stopReason?: string | null
  rounds?: RoundAudit[]
  mode?: string
  residentError?: string | null
  /** S17 打断点:stop/interrupt 时 transcript 停在哪,面板照此画线。null=没被打断/开题前就停。 */
  interruptedAt?: { round: number; seq: number } | null
  streaming?: Record<string, { round: number; kind: 'text' | 'tools'; text: string }>
  decisionSummary?: string | null
  /** 结论文档(ADR-0019):相对工作区路径 + 绝对路径;null=没写(未指定工作区或写入失败)。 */
  reportRel?: string | null
  reportPath?: string | null
  /** 落盘/落文件失败原因(null=正常)。两条独立,分开显示,因为修法不同。 */
  persistError?: string | null
  reportError?: string | null
  /** 本局是从磁盘恢复的(宿主重启后仍打得开)。 */
  restored?: boolean
}

let openPanel: (() => void) | null = null
const openListeners = new Set<(v: boolean) => void>()
let panelOpen = false
const subscribeOpen = (fn: (v: boolean) => void): (() => void) => { openListeners.add(fn); return () => { openListeners.delete(fn) } }
const setPanelOpen = (v: boolean): void => { panelOpen = v; openListeners.forEach((fn) => fn(v)) }
// 多仓任务面板(ADR-0025):与辩论面板同为 shell.overlay 对话框,独立开关。
// 原生发送键不可拦截(inputActions 全仓只有 setDraft),任务启动必须走面板显式按钮。
let openTaskPanel: (() => void) | null = null
const openTaskListeners = new Set<(v: boolean) => void>()
let taskPanelOpen = false
const subscribeTaskOpen = (fn: (v: boolean) => void): (() => void) => { openTaskListeners.add(fn); return () => { openTaskListeners.delete(fn) } }
const setTaskPanelOpen = (v: boolean): void => { taskPanelOpen = v; openTaskListeners.forEach((fn) => fn(v)) }
let prefillQuestion = ''
// 多仓任务描述(ADR-0028):入口收输入框草稿,TaskDialog 挂载时预填,可改,草稿不清。
let prefillTaskDesc = ''
// 当前会话 id(input.right 是 session scope,标准 props 自带 sessionId,入口每次渲染更新)。
let currentSid = ''
interface InputActs { setDraft(d: string): void; submit?(): void }

// 建单成功后清空输入框的回调(InputEntry 注册,DebateDialog 建单成功后调用)。
let clearDraftOnStart: (() => void) | null = null
// 输入桥:保留给回填地图用(触发语链已删除,v0.3 host 直驱)。
let bridgeInsert: ((text: string) => void) | null = null

function useTr(): (k: string, vars?: Record<string, string | number>) => string {
  return useCallback((k: string, vars?: Record<string, string | number>) => {
    let s = DICTS.zh[k] ?? k
    if (vars) for (const key in vars) s = s.split(`{${key}}`).join(String(vars[key]))
    return s
  }, [])
}

function routeLabel(r: { provider: string; model: string }): string {
  return `${r.provider}/${r.model}`
}

// 人话标签见 ./labels(纯函数,单测不拖 React/CSS)。

// ---------- 全屏测量:罩会话列整列(与 explorer 不同,纵向盖住输入框) ----------
// 左边界顺输入框向上冒泡找会话列容器;右 = details 栏左 edge - 8;
// 上下各留 16px 边距,纵向盖住输入框(辩论框全屏只看实况,不需拖拽进输入框;
// 复制地图走剪贴板/输入桥)。Esc 或标题栏按钮退出全屏。
const viewportHeight = (): number => Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight)
const rectOf = (el: Element | null): DOMRect | null =>
  el instanceof HTMLElement ? el.getBoundingClientRect() : null
const isVisibleRect = (r: DOMRect | null): r is DOMRect =>
  !!r && r.width > 0 && r.height > 0
function pickVisible(sel: string): Element | null {
  const all = Array.from(document.querySelectorAll(sel))
  let best: Element | null = null
  let bestArea = 0
  for (const el of all) {
    const r = rectOf(el)
    if (!isVisibleRect(r)) continue
    const area = r.width * r.height
    if (area > bestArea) { bestArea = area; best = el }
  }
  return best
}
const queryComposer = (): Element | null =>
  pickVisible('[data-slot="conversation.composer.bar"], [data-slot="conversation.composer"], [data-composer-card]')
const queryConvCol = (header: Element | null): Element | null => {
  const viaHeader = header instanceof HTMLElement ? header.closest('[data-slot="conversation"]') : null
  if (viaHeader instanceof HTMLElement && isVisibleRect(rectOf(viaHeader))) return viaHeader
  return pickVisible('[data-slot="conversation"]')
}
const queryHeader = (): Element | null =>
  pickVisible('[data-slot="conversation.session.header"]')
const measureFullscreen = (): { top: number; left: number; width: number; height: number } => {
  const vh = viewportHeight()
  const vw = window.innerWidth
  const header = queryHeader()
  const composer = queryComposer()
  const details = pickVisible('[data-slot="details"]')
  const composerRect = rectOf(composer)
  const dtRect = rectOf(details)
  let colRect: DOMRect | null = null
  let colLeft: number | null = null
  if (composer instanceof HTMLElement && isVisibleRect(composerRect)) {
    let p: HTMLElement | null = composer.parentElement
    while (p && p !== document.body) {
      const r = rectOf(p)
      if (isVisibleRect(r) && r.width >= composerRect.width + 40) {
        if (colLeft === null) colLeft = r.left
        if (r.top <= composerRect.top - 100) { colRect = r; break }
      }
      p = p.parentElement
    }
  }
  if (!colRect) {
    const col = queryConvCol(header)
    const r = rectOf(col)
    if (isVisibleRect(r)) colRect = r
  }
  const left = colRect ? Math.round(colRect.left) + 8 : colLeft !== null ? Math.round(colLeft) + 8 : 16
  const right = isVisibleRect(dtRect) && dtRect.left > left ? Math.round(dtRect.left) - 8 : vw - 16
  // 纵向盖住输入框:上下只留 16px 边距。composerRect 不再参与测量
  // (explorer 要拖文件进输入框才露出来,辩论框不需要)。
  void composerRect
  const top = 16
  const bottomLimit = vh - 16
  return {
    top,
    left,
    width: Math.max(320, right - left),
    height: Math.max(320, bottomLimit - top),
  }
}

function DebateDialog(props: { onClose: () => void; useSessions?: (s: unknown) => unknown }): React.ReactNode {
  const tr = useTr()
  const [builder, setBuilder] = useState(0)
  const [challenger, setChallenger] = useState(2)
  const [synth, setSynth] = useState(0)
  // 轮数输入存字符串:空串就是空串,backspace 删得掉;提交时再转数字(空/非法回落默认 5,钳到 1~20)。
  // 存 number 会 Number('')===0 回填,删出 0 后再也删不掉(线上实测:5→backspace→0→删不掉)。
  const [roundsText, setRoundsText] = useState('5')
  // 跟局 id:聊天开局后模型返回的会话 id,面板粘贴即看实况。
  const [followId, setFollowId] = useState('')
  // targetCwd 面板不再露:面板开局自动继承会话 cwd;HTTP 建单默认进程目录。
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [resolved, setResolved] = useState<AutoResolved | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  // 停机审计:host 早就经 /state 返回 stopReason + rounds[],之前面板没接,现在接上(QAS-2)。
  const [stopReason, setStopReason] = useState<string | null>(null)
  const [roundAudits, setRoundAudits] = useState<RoundAudit[]>([])
  const [mode, setMode] = useState('')
  const [mirrorCount, setMirrorCount] = useState(0)
  const [mirrorError, setMirrorError] = useState<string | null>(null)
  // 收尾陈述(v4):host 在辩论结束后拼好的决策摘要,面板置顶展示 + 一键回填输入框。
  const [decision, setDecision] = useState<string | null>(null)
  /**
   * 结论文档与持久化可观测性(ADR-0019)。
   * reportPath=落盘的 md 绝对路径;两条失败原因分开存:落盘失败(整局记录)与
   * 落文件失败是两件事,修法不同(前者看存储后端,后者看工作区权限),混成一句没法排查。
   * restored=本局是从磁盘恢复的,不是本次进程新建的。
   */
  const [reportPath, setReportPath] = useState<string | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const [interruptedAt, setInterruptedAt] = useState<{ round: number; seq: number } | null>(null)
  /**
   * 版本对账(v0.4):徽标显示**后台真正在跑的版本**(host 内联常量),不是磁盘版本。
   * null = 还没拿到;verMissing = 后台没这条路由(旧宿主)或取数失败。
   */
  const [ver, setVer] = useState<VersionResp | null>(null)
  const [verMissing, setVerMissing] = useState(false)
  // 实时流:host 把常驻 turn 的流式累计文本推到 state.streaming,面板即见打字机效果。
  const [streams, setStreams] = useState<Record<string, { round: number; kind: 'text' | 'tools'; text: string }>>({})
  // 秒级进度(host 每方开写/写完都更新,面板 2s 轮询即见,不用等模型输出)。
  const [progress, setProgress] = useState('')
  // 窗口态:全屏罩会话区 / 最小化缩成胶囊(轮询不停,恢复即见最新实况)。
  const [fullscreen, setFullscreen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [fullRect, setFullRect] = useState({ top: 0, left: 16, width: 640, height: 480 })
  // 手动尺寸:localStorage 持久化,双击拉手恢复默认。
  const [manualH, setManualH] = useState<number | null>(() => loadManualHeight())
  const [manualW, setManualW] = useState<number | null>(() => loadManualWidth())
  const timer = useRef<number | null>(null)
  const toggleFullscreen = (): void => {
    if (!fullscreen) {
      try { setFullRect(measureFullscreen()) } catch { /* 测量失败用旧矩形 */ }
    }
    setFullscreen((v) => !v)
  }
  // Esc:全屏时先退全屏,再按才关;最小化时先恢复。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      let handled = false
      setFullscreen((v) => { if (v) { handled = true; return false } return v })
      if (handled) return
      setMinimized((v) => { if (v) { handled = true; return false } return v })
      if (!handled) props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 全屏时跟随窗口/布局重测矩形。
  useEffect(() => {
    if (!fullscreen) return
    const update = (): void => { try { setFullRect(measureFullscreen()) } catch { /* 保持旧矩形 */ } }
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => { window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update) }
  }, [fullscreen])
  // 右下角拉手:右拉变宽/下拉变高,松开即存 localStorage;双击恢复默认。
  // 全屏时拉手仍可见,第一次拖动即退出全屏(从当前视觉尺寸连续收缩,不跳变)。
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number; curW: number; curH: number; moved: boolean; wasFullscreen: boolean } | null>(null)
  const fullscreenRef = useRef(fullscreen)
  fullscreenRef.current = fullscreen
  const fullRectRef = useRef(fullRect)
  fullRectRef.current = fullRect
  const applyResizeDelta = (clientX: number, clientY: number): void => {
    const st = resizeRef.current
    if (!st) return
    if (!st.moved) {
      st.moved = true
      if (st.wasFullscreen) setFullscreen(false)
    }
    const h = clampDialogHeight(st.startH + (clientY - st.startY), 48, viewportHeight())
    const w = clampDialogWidth(st.startW + (clientX - st.startX), window.innerWidth)
    st.curW = w
    st.curH = h
    setManualW(w)
    setManualH(h)
  }
  const endResize = (): void => {
    // 点按无移动直接丢弃(全屏下点一下不应把全屏尺寸存成手动尺寸)。
    if (resizeRef.current?.moved) { saveManualWidth(resizeRef.current.curW); saveManualHeight(resizeRef.current.curH) }
    resizeRef.current = null
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', endResize)
    document.removeEventListener('touchmove', onResizeTouchMove)
    document.removeEventListener('touchend', endResize)
  }
  const onResizeMove = (ev: MouseEvent): void => applyResizeDelta(ev.clientX, ev.clientY)
  const onResizeTouchMove = (ev: TouchEvent): void => {
    if (ev.touches.length > 0) applyResizeDelta(ev.touches[0].clientX, ev.touches[0].clientY)
  }
  const onResizeDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const wasFullscreen = fullscreenRef.current
    const fr = fullRectRef.current
    const startW = wasFullscreen ? fr.width : manualW ?? DIALOG_DEFAULT_W
    const startH = wasFullscreen ? fr.height : manualH ?? DIALOG_DEFAULT_H
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW, startH, curW: startW, curH: startH, moved: false, wasFullscreen }
    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', endResize)
  }
  const onResizeTouchStart = (e: React.TouchEvent): void => {
    if (e.touches.length === 0) return
    const wasFullscreen = fullscreenRef.current
    const fr = fullRectRef.current
    const startW = wasFullscreen ? fr.width : manualW ?? DIALOG_DEFAULT_W
    const startH = wasFullscreen ? fr.height : manualH ?? DIALOG_DEFAULT_H
    resizeRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, startW, startH, curW: startW, curH: startH, moved: false, wasFullscreen }
    document.addEventListener('touchmove', onResizeTouchMove, { passive: false })
    document.addEventListener('touchend', endResize)
  }
  const onResizeReset = (): void => {
    if (fullscreenRef.current) setFullscreen(false)
    setManualH(null); saveManualHeight(null); setManualW(null); saveManualWidth(null)
  }
  // 当前会话 id + cwd:服务线 sessionCwd 优先(0.2.0 官方线),overlay 快照只做回退。
  let liveSid = currentSid
  let liveCwd: string | null = sessionCwd
  try {
    const snap = props.useSessions ? (props.useSessions((s: unknown) => s) as { current?: unknown; byId?: Record<string, { cwd?: unknown }> }) : undefined
    if (typeof snap?.current === 'string' && snap.current !== '') liveSid = snap.current
    // 0.2.0 快照已无 current:用 input.right 传的 sessionId(liveSid)直取 byId,不再靠 snap.current。
    const byId = snap?.byId ?? {}
    const cur = byId[liveSid]
    if (typeof cur?.cwd === 'string' && cur.cwd !== '') liveCwd = cur.cwd
  } catch { /* store 不可用时用 input.right 缓存 */ }
  // 实况自动滚到底:新条目进来才滚,用户往上翻看历史时不抢滚动。
  const feedRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const poll = useCallback(async (id: string) => {
    try {
      const s = await api<StateResp>('state', { id })
      if (!s.ok) { setError(s.error ?? 'state failed'); return }
      setStatus(s.status ?? 'running')
      setTurns(s.transcript ?? [])
      if (s.auto !== undefined) setResolved(s.auto)
      if (typeof s.progress === 'string' && s.progress !== '') setProgress(s.progress)
      if (s.stopReason !== undefined) setStopReason(s.stopReason)
      if (Array.isArray(s.rounds)) setRoundAudits(s.rounds)
      if (typeof s.mode === 'string') setMode(s.mode)
      if (typeof s.mirrorCount === 'number') setMirrorCount(s.mirrorCount)
      if (s.mirrorError !== undefined) setMirrorError(s.mirrorError)
      if (s.streaming !== undefined) setStreams(s.streaming)
      if (s.decisionSummary !== undefined) setDecision(s.decisionSummary)
      if (s.reportPath !== undefined) setReportPath(s.reportPath)
      if (s.persistError !== undefined) setPersistError(s.persistError)
      if (s.reportError !== undefined) setReportError(s.reportError)
      if (s.restored !== undefined) setRestored(s.restored === true)
      if (s.interruptedAt !== undefined) setInterruptedAt(s.interruptedAt)
      if (s.status === 'done' || s.status === 'failed' || s.status === 'stopped') {
        if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
        if (s.status === 'failed') setError(s.error ?? 'failed')
      }
    } catch (e) {
      setError(String(e))
    }
  }, [])

  /**
   * 版本对账取数(15s 一次,开销 = 一次 stat + 读一个小 JSON)。
   * 只在面板打开期间跑:重建 bundle 后无需重启宿主就能看到"需重启宿主"提示——
   * 这正是此前"徽标说 v0.3.0、后台跑 v0.2.0"的盲区。
   */
  useEffect(() => {
    let alive = true
    const fetchVersion = async (): Promise<void> => {
      try {
        // 不用共享 api():那条路假设响应一定是 JSON。这里非 2xx(旧宿主没这条路由,
        // 实测返回 405)必须当成"后台版本未知",不能静默当成成功。
        const res = await fetch('/dsh-session-enhance/api/version', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (!res.ok) { if (alive) setVerMissing(true); return }
        const v = await res.json() as VersionResp
        if (!alive) return
        if (v.ok !== true || typeof v.running !== 'string') { setVerMissing(true); return }
        setVerMissing(false)
        setVer(v)
      } catch {
        if (alive) setVerMissing(true)
      }
    }
    void fetchVersion()
    const t = window.setInterval(() => { void fetchVersion() }, 15000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])

  useEffect(() => () => {
    if (timer.current !== null) window.clearInterval(timer.current)  }, [])

  /** 轮数提交值:空/非法回落默认 5,钳到 1~20(host 侧 normalizeConfig 同口径再兜底)。 */
  const roundsToSubmit = (): number => {
    const n = Math.floor(Number(roundsText))
    if (!Number.isFinite(n)) return 5
    return Math.min(20, Math.max(1, n))
  }

  const start = async (): Promise<void> => {
    setError(null); setTurns([]); setCopied(false); setResolved(null); setProgress('')
    setStopReason(null); setRoundAudits([]); setMode(''); setMirrorCount(0); setMirrorError(null); setStreams({}); setDecision(null)
    stickRef.current = true
    // 硬触发:按钮直调 HTTP 建单即直驱,不经模型转述。hint=输入框问题快照,
    // cwd=当前会话工作区(面板从 useSessions 读,host 侧 Web 会话不可见,只能面板传),
    // sid=当前会话 id(读会话背景用,拿不到也不挡路)。
    // 建单成功才清空输入框(内容已收进 hint)。
    const hint = prefillQuestion.trim()
    if (hint === '') { setError('先在输入框写下要辩的问题'); return }
    try {
      const r = await api<{ ok: boolean; id?: string; error?: string }>('start', {
        builder: MODELS[builder],
        challenger: MODELS[challenger],
        synthesizer: MODELS[synth],
        maxRounds: roundsToSubmit(),
        hint,
        sid: liveSid,
        cwd: liveCwd,
      })
      if (!r.ok || !r.id) { setError(r.error ?? 'start failed'); return }
      try { clearDraftOnStart?.() } catch { /* 忽略 */ }
      prefillQuestion = ''
      // 建单成功即最小化:辩论是后台长任务,面板缩成右下角胶囊(带 running 绿点),
      // 进度走对话区 mirror + 胶囊点回。用户点 ✕ 是关面板,点 — 是最小化,开始即后者。
      setMinimized(true)
      // 建单的 id 自己知道,直接跟局看实况(轮询 transcript 即时追加,自动滚到底)。
      setFollowId(r.id)
      await follow(r.id)
    } catch (e) {
      setError(String(e))
    }
  }

  /** 跟局:模型开局返回会话 id 后,面板用此 id 轮询实况(展示专用,不建单)。 */
  const follow = async (id: string): Promise<void> => {
    const sid = id.trim()
    if (sid === '') return
    setError(null); setTurns([]); setCopied(false); setResolved(null); setProgress('')
    setStopReason(null); setRoundAudits([]); setMode(''); setMirrorCount(0); setMirrorError(null); setStreams({}); setDecision(null)
    stickRef.current = true
    setSessionId(sid)
    setStatus('running')
    setProgress('跟局中…')
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = window.setInterval(() => { void poll(sid) }, 2000)
    void poll(sid)
  }

  const stop = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await api('stop', { id: sessionId })
      setStatus('stopped')
      if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
    } catch (e) {
      setError(String(e))
    }
  }

  // S17 一键双停:停 parent turn(留住用户刚说的话) + abort 后台 debate。
  const interrupt = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await api('interrupt', { id: sessionId })
      setStatus('stopped')
      if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
    } catch (e) {
      setError(String(e))
    }
  }

  // T1 探针 P1:对发起会话真调一次 followup,看会话区是否进入运行态。
  // debateId 从本局面拿 parentSid,用户不用找会话 id。只发一条无害心跳。
  const probeTurn = async (): Promise<void> => {
    if (!sessionId) return
    try {
      const r = await api<{ ok: boolean; statusBefore?: unknown; statusAfter?: unknown; error?: string }>('debug-followup', { debateId: sessionId })
      if (!r.ok) { setError(r.error ?? 'probe failed'); return }
      setError(`探针已发:turn 前 status=${String(r.statusBefore)} → 3s 后=${String(r.statusAfter)}。看会话区:发送按钮变停止了吗?有蓝字吗?`)
    } catch (e) {
      setError(String(e))
    }
  }

  const copyMap = (): void => {
    const last = turns.length > 0 ? turns[turns.length - 1].text : ''
    if (!last) return
    if (bridgeInsert) {
      bridgeInsert(last)
      setCopied(true)
    } else if (navigator.clipboard) {
      void navigator.clipboard.writeText(last).then(() => setCopied(true))
    }
  }

  /**
   * 收尾陈述一键回填:有 bridgeInsert(输入框注入桥)就填进输入框,否则退剪贴板。
   * 用户看完决策摘要通常紧接着就要接着干活,所以优先回填输入框而不是只复制。
   */
  const copyDecision = async (): Promise<void> => {
    const text = decision ?? ''
    if (text.trim() === '') return
    if (bridgeInsert) {
      bridgeInsert(text)
      setCopied(true)
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    }
  }

  /**
   * 复制结论文档路径。
   * 回填输入框对路径没意义(用户要的是拿去 open/read),所以这里只进剪贴板不碰输入框。
   */
  const copyReportPath = async (): Promise<void> => {
    if (reportPath === null) return
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(reportPath)
      setCopiedPath(true)
    }
  }

  // 新条目追加时自动滚到底(用户手动上翻后不再抢滚动)。
  useEffect(() => {
    const el = feedRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [turns.length])

  const onFeedScroll = (): void => {
    const el = feedRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // 谁在写:从进度文案里提炼,画呼吸灯(运行中且尚无对应输出时亮)。
  const writing = (role: string): boolean => {
    if (status !== 'running') return false
    if (role === 'synthesizer') return /制图/.test(progress) && !turns.some((t) => t.role === 'synthesizer')
    if (/建构者与挑战者互盲开写/.test(progress)) return !turns.some((t) => t.round === 0 && t.role === role)
    if (/建构方开写|建构者开题/.test(progress)) return role === 'builder'
    if (/挑战方开写|挑战者开题/.test(progress)) return role === 'challenger'
    return false
  }

  // ---------- 版本真值(v0.4):徽标必须等于"后台真正在跑的版本" ----------
  // 取不到后台版本时显示 v? 并说明原因——绝不回落成本 bundle 的版本冒充后台版本,
  // 那正是"徽标 v0.3.0、后台跑 v0.2.0"这个谎的来源。
  const hostUnknown = verMissing || (ver !== null && typeof ver.running !== 'string')
  const runningVersion = ver?.running ?? ''
  const clientStale = runningVersion !== '' && isClientStale(BUILD_VERSION, runningVersion)
  const versionText = hostUnknown ? 'v?' : `v${runningVersion}`
  const versionTip = hostUnknown
    ? tr('ver.unknownTip')
    : tr('ver.tip', { host: runningVersion, client: BUILD_VERSION, disk: ver?.disk ?? '?' })
  const versionWarn = hostUnknown
    ? tr('ver.unknown')
    : ver?.stale === true
      ? tr('ver.hostStale', { reason: ver.reason ?? '' })
      : clientStale
        ? tr('ver.clientStale', { client: BUILD_VERSION, host: runningVersion })
        : null

  // 最小化胶囊:只占右下角一条,轮询不停,点恢复回到完整窗口。
  if (minimized) {
    const miniLabel = status === 'running' ? tr('minimized.running') : status === 'done' ? tr('minimized.done') : tr(`st.${status}`)
    return (
      <button className={C('dshe-mini')} onClick={() => setMinimized(false)} title={tr('btn.restore')} aria-label={tr('btn.restore')}>
        <span className={C(status === 'running' ? 'dot-live' : 'dot-done')} />
        <span>⚔ {miniLabel}</span>
        <span className={C('dshe-version') + (versionWarn !== null ? ` ${C('dshe-version-warn')}` : '')} title={versionTip}>{versionText}{versionWarn !== null ? ' ⚠' : ''}</span>
      </button>
    )
  }
  const overlayStyle: React.CSSProperties = fullscreen
    ? { top: fullRect.top, left: fullRect.left, width: fullRect.width, height: fullRect.height, maxHeight: 'none' }
    : {
        width: clampStoredWidth(manualW, typeof window === 'undefined' ? 1280 : window.innerWidth) ?? DIALOG_DEFAULT_W,
        height: clampStoredHeight(manualH, 48, typeof window === 'undefined' ? 800 : viewportHeight()) ?? DIALOG_DEFAULT_H,
      }
  return (
    <div
      className={C('dshe-overlay') + (fullscreen ? ` ${C('dshe-overlay-full')}` : '')}
      role="dialog" aria-label={tr('panel.title')}
      style={overlayStyle}
    >
      <div className={C('dshe-header')}>
        <span>⚔ {tr('panel.title')}</span>
        <span className={C('dshe-version') + (versionWarn !== null ? ` ${C('dshe-version-warn')}` : '')} title={versionTip}>{versionText}{versionWarn !== null ? ' ⚠' : ''}</span>
        <span className={C('spacer')} />
        <button className={C('dshe-hbtn')} onClick={toggleFullscreen} title={fullscreen ? tr('btn.unfullscreen') : tr('btn.fullscreen')} aria-label={fullscreen ? tr('btn.unfullscreen') : tr('btn.fullscreen')}>{fullscreen ? '⤢' : '⛶'}</button>
        <button className={C('dshe-hbtn')} onClick={() => setMinimized(true)} title={tr('btn.minimize')} aria-label={tr('btn.minimize')}>—</button>
        <button className={C('dshe-close')} onClick={props.onClose} aria-label={tr('btn.close')}>✕</button>
      </div>
      <div className={C('dshe-body')}>
        <div className={C('dshe-note')}>{tr('auto.note')}</div>
        {/* 版本告警(v0.4):后台不是最新代码时明确说清楚,别让徽标骗人。 */}
        {versionWarn !== null && (
          <div className={C('dshe-verwarn')} role="alert">
            <b>{tr('ver.warnTitle')}</b>
            <span>{versionWarn}</span>
          </div>
        )}
        {/* 实况进度置顶:谁在写一眼可见 */}
        {progress !== '' && (status === 'running' || status === 'done') && (
          <div className={C('dshe-livebar')}>
            <span className={C(status === 'running' ? 'dot-live' : 'dot-done')} />
            <span>{progress}</span>
          </div>
        )}
        {status === 'running' && (writing('builder') || writing('challenger') || writing('synthesizer')) && (
          <div className={C('dshe-note')}>
            {writing('builder') && '✍ 建构者正在写…'}
            {writing('challenger') && '✍ 挑战者正在写…'}
            {writing('synthesizer') && '✍ 制图员正在写…'}
          </div>
        )}
        {prefillQuestion.trim() !== '' && (
          <div className={C('dshe-resolved')}>
            <div><b>{tr('auto.question')}</b>{prefillQuestion.trim()}</div>
          </div>
        )}
        <div className={C('dshe-field')}>
          <span>{tr('builder.label')}</span>
          <select value={builder} onChange={(e) => setBuilder(Number(e.target.value))} disabled={status === 'running'}>
            {MODELS.map((m, i) => <option key={i} value={i}>{routeLabel(m)}</option>)}
          </select>
        </div>
        <div className={C('dshe-field')}>
          <span>{tr('challenger.label')}</span>
          <select value={challenger} onChange={(e) => setChallenger(Number(e.target.value))} disabled={status === 'running'}>
            {MODELS.map((m, i) => <option key={i} value={i}>{routeLabel(m)}</option>)}
          </select>
        </div>
        <div className={C('dshe-field')}>
          <span>{tr('synth.label')}</span>
          <select value={synth} onChange={(e) => setSynth(Number(e.target.value))} disabled={status === 'running'}>
            {MODELS.map((m, i) => <option key={i} value={i}>{routeLabel(m)}</option>)}
          </select>
        </div>
        <div className={C('dshe-field')}>
          <span>{tr('rounds.label')}</span>
          <input type="number" min={1} max={20} value={roundsText} placeholder="5(默认)" onChange={(e) => setRoundsText(e.target.value)} disabled={status === 'running'} />
        </div>
        <div className={C('dshe-note')}>输入框写问题 → 点开始辩论即开(工作区自动取当前会话,不用填)。实况在本面板看,跑完点"复制成果地图"并回对话。</div>
        {resolved !== null && (
          <div className={C('dshe-resolved')}>
            <div><b>{tr('auto.question')}</b>{resolved.question}</div>
            <div><b>{tr('auto.type')}</b>{tr(`type.${resolved.questionType}`) ?? resolved.questionType} · {resolved.lenses}{tr('auto.lensesUnit')} · {tr('auto.ctx')}{resolved.contextChars}{tr('auto.charsUnit')}{resolved.targetCwd ? ` · 目标:${resolved.targetCwd}` : ''}</div>
          </div>
        )}
        {/* 收尾陈述(v4):辩论一结束就置顶。这是用户决定下一步的依据,所以单独一块、可一键复制。 */}
        {decision !== null && decision.trim() !== '' && (
          <div className={C('dshe-decision')}>
            <div className={C('dshe-decision-head')}>
              <span>{tr('decision.title')}</span>
              <button className={C('dshe-copybtn')} onClick={() => { void copyDecision() }}>{copied ? tr('trigger.copied') : tr('decision.copy')}</button>
            </div>
            <div className={C('dshe-decision-body')}>{decision.replace(/^##\s*[^\n]*\n?/, '').trim()}</div>
          </div>
        )}
        {/* 结论文档(ADR-0019):把"有地址的产物"摆出来——路径不给,文件就等于不存在。 */}
        {reportPath !== null && (
          <div className={C('dshe-report')}>
            <span>{tr('report.saved')}</span>
            <code title={reportPath}>{reportPath}</code>
            <button className={C('dshe-copybtn')} onClick={() => { void copyReportPath() }}>{copiedPath ? tr('trigger.copied') : tr('report.copy')}</button>
          </div>
        )}
        {/* 两条失败原因分开显示:落盘失败查存储后端,落文件失败查工作区权限。 */}
        {(persistError !== null || reportError !== null) && (
          <div className={C('dshe-verwarn')} role="alert">
            <b>{tr('report.warnTitle')}</b>
            {persistError !== null && <span>{tr('report.persistFail', { err: persistError })}</span>}
            {reportError !== null && reportError !== 'no-target-cwd' && <span>{tr('report.fileFail', { err: reportError })}</span>}
            {reportError === 'no-target-cwd' && <span>{tr('report.noCwd')}</span>}
          </div>
        )}
        {/* 恢复标记:宿主重启后旧局仍打得开,但要说清它是恢复的、且不会再跑。 */}
        {restored && (
          <div className={C('dshe-restored')}>{tr('report.restored')}</div>
        )}
        <div className={C('dshe-actions')}>
          {status === 'running' || status === 'polling'
            ? <>
                <button className={C('dshe-stop')} onClick={() => { void stop() }} disabled={status === 'polling'} title={status === 'polling' ? '等模型开局:输入框回车后自动跟局' : undefined}>{tr('btn.stop')}</button>
                {/* S17 一键双停:连发起会话的 turn 一起停(用户刚说的话留着)。 */}
                <button className={C('dshe-stop')} onClick={() => { void interrupt() }} disabled={status === 'polling'} title={tr('btn.interruptTip')}>{tr('btn.interrupt')}</button>
                {/* T1 探针 P1:对发起会话真调一次 followup,看会话区是否进入运行态。 */}
                <button className={C('dshe-stop')} onClick={() => { void probeTurn() }} title="T1 探针:发一条无害心跳进发起会话,看发送按钮/蓝字变没变">探针起 turn</button>
              </>
            : <button className={C('dshe-start')} onClick={() => { void start() }}>{tr('btn.start')}</button>}
          <span className={C('dshe-status')}>{tr(`st.${status}`)}</span>
        </div>
        {/* 跟局:本局 id(建单自动填);旧局 id 可手动粘贴回来重看。宿主重启后旧局不再作废——
            host 启动时会把磁盘上的整局记录装回内存(ADR-0019),所以粘贴旧 id 仍能取到结论。 */}
        {(status === 'idle' || status === 'polling' || status === 'stopped') && (
          <div className={C('dshe-field')}>
            <span>会话 id</span>
            <input type="text" value={followId} onChange={(e) => setFollowId(e.target.value)} placeholder="se-…(本局自动填,旧局可粘贴)" />
            <div className={C('dshe-actions')}>
              <button className={C('dshe-start')} onClick={() => { void follow(followId) }} disabled={followId.trim() === ''}>跟局看实况</button>
            </div>
          </div>
        )}
        {sessionId !== null && status === 'done' && turns.length > 0 && (
          <div className={C('dshe-field')}>
            <span>{tr('draft.hint')}</span>
            <div className={C('dshe-actions')}>
              <button className={C('dshe-stop')} onClick={copyMap}>{copied ? tr('trigger.copied') : tr('trigger.copy')}</button>
            </div>
          </div>
        )}
        {/* 停机审计:stopReason + 每轮人话小结(判定数据翻译,不调模型)。 */}
        {(stopReason !== null || roundAudits.length > 0) && (status === 'done' || status === 'running') && (
          <div className={C('dshe-resolved')}>
            <div><b>{tr('audit.title')}</b>{stopReason !== null ? tr(stopKey(stopReason, roundAudits, resolved?.maxRounds)) : tr('stop.pending')}{mode !== '' && mode !== 'resident' ? ` · ${mode}` : ''}</div>
            {roundAudits.length > 0 && (
              <div><b>{tr('summary.title')}</b></div>
            )}
            {roundAudits.map((r) => (
              <div key={r.round} title={
                `${tr('audit.quoted.tip')} · ${tr('audit.relay.tip')}: ${r.builderRelayChars}`
              }>
                {r.round <= 0 ? tr('round.opening') : tr('round.n', { n: r.round })}: {roundSummary(r, tr)}
              </div>
            ))}
          </div>
        )}
        {/* 镜像状态:对话区有没有同步,不再静默(mirrorCount/mirrorError host 早就有)。 */}
        {sessionId !== null && status !== 'idle' && (
          <div className={C('dshe-note')}>
            {mirrorCount > 0 ? `${tr('mirror.on')} ×${mirrorCount}` : tr('mirror.off')}
            {mirrorError !== null ? ` · ${tr('mirror.fail')}:${mirrorError}` : ''}
          </div>
        )}
        {error !== null && <div className={C('dshe-error')}>{error}</div>}
        {/* 实时流:正在写的各方当前 turn 流式文本,打字机效果(结论落 transcript 即替换成正式 TurnCard)。 */}
        {status === 'running' && Object.keys(streams).map((role) => {
          const st = streams[role]
          if (!st || st.text === '') return null
          return <StreamCard key={`stream-${role}`} role={role} round={st.round} kind={st.kind} text={st.text} />
        })}
        {turns.length > 0 && (
          <div className={C('dshe-feed')} ref={feedRef} onScroll={onFeedScroll}>
            {turns.map((t) => (
              <span key={t.seq}>
                <TurnCard turn={t} />
                {/* S17 打断线:停在 transcript 哪,面板照此画线,不猜不编。 */}
                {interruptedAt !== null && t.seq === interruptedAt.seq && (
                  <div className={C('dshe-interrupted')}>{tr('interrupt.mark')}</div>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* 右下角拉手:拖拽调尺寸(宽高同时),双击恢复默认;全屏时拖动即退全屏 */}
      {!minimized && (
        <div
          className={C('dshe-resize-corner')}
          onMouseDown={onResizeDown} onTouchStart={onResizeTouchStart} onDoubleClick={onResizeReset}
          title={tr('resize.tip')} role="separator" aria-orientation="horizontal" aria-label={tr('resize.tip')}
        ><span className={C('dshe-resize-corner-bar')} /></div>
      )}
    </div>
  )
}

/** TurnCard 实录分段逻辑见 ./sections(纯函数,单测不拖 React/CSS)。 */

/** 流式卡片:复用同一套分段折叠,但标实时身份,且只展示末尾一段(避免长文刷屏)。 */
function StreamCard(props: { role: string; round: number; kind: 'text' | 'tools'; text: string }): React.ReactNode {
  const tr = useTr()
  const who = `${roundLabel(props.round, props.role, tr)} · ${roleName(props.role, tr)}`
  // 工具心跳是单行状态,不走三段分段,直接渲染。
  if (props.kind === 'tools') {
    return (
      <div className={C('dshe-turn-stream')}>
        <div className={C('who')}>{who}{tr('stream.tools')}</div>
        <div>{props.text}<span className={C('caret')}>▍</span></div>
      </div>
    )
  }
  const { summary, detail, delta, rest } = splitSections(props.text)
  const tail = (s: string): string => {
    const lines = s.split('\n').filter((l) => l.trim() !== '')
    return lines.slice(-8).join('\n')
  }
  return (
    <div className={C('dshe-turn-stream')}>
      <div className={C('who')}>{who}{tr('stream.writing')}</div>
      {rest !== '' ? <div>{tail(rest)}<span className={C('caret')}>▍</span></div> : (
        <>
          {summary !== '' && <div className={C('dshe-summary')}>{tail(summary)}<span className={C('caret')}>▍</span></div>}
          {delta !== '' && <div className={C('dshe-delta')}>Δ {delta.split('\n')[0]}</div>}
          {detail !== '' && <div className={C('dshe-note')}>{tail(detail)}</div>}
        </>
      )}
    </div>
  )
}

function TurnCard(props: { turn: Turn }): React.ReactNode {
  const t = props.turn
  const tr = useTr()
  const [open, setOpen] = useState(false)
  const { summary, detail, delta, rest } = splitSections(t.text)
  const segmented = rest === ''
  return (
    <div className={C('dshe-turn')}>
      <div className={C('who')}>{roundLabel(t.round, t.role, tr)} · {roleName(t.role, tr)}</div>
      {!segmented && <div>{t.text}</div>}
      {segmented && (
        <>
          {summary !== '' && <div className={C('dshe-summary')}>{summary}</div>}
          {delta !== '' && <div className={C('dshe-delta')}>Δ {delta.split('\n')[0]}</div>}
          <button className={C('dshe-foldbtn')} onClick={() => setOpen((v) => !v)}>
            {open ? '收起详细论证 ▲' : '展开详细论证 ▼'}
          </button>
          {open && (
            <>
              {detail !== '' && <div>{detail}</div>}
              {delta !== '' && <div className={C('dshe-delta-full')}>{delta}</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}
function DebateRoot(props: { useSessions?: (s: unknown) => unknown }): React.ReactNode {
  const [open, setOpen] = useState(panelOpen)
  const [taskOpen, setTaskOpen] = useState(taskPanelOpen)
  useEffect(() => subscribeOpen(setOpen), [])
  useEffect(() => subscribeTaskOpen(setTaskOpen), [])
  useEffect(() => {
    openPanel = () => setPanelOpen(true)
    return () => { if (openPanel !== null) openPanel = null }
  }, [])
  useEffect(() => {
    openTaskPanel = () => setTaskPanelOpen(true)
    return () => { if (openTaskPanel !== null) openTaskPanel = null }
  }, [])
  return (
    <>
      {open && <DebateDialog onClose={() => setPanelOpen(false)} useSessions={props.useSessions} />}
      {taskOpen && <TaskDialog onClose={() => setTaskPanelOpen(false)} useSessions={props.useSessions} />}
    </>
  )
}

function InputButton(props: { useInput?: (s: unknown) => unknown; inputActions?: InputActs }): React.ReactNode {
  // 订阅草稿:有内容才亮,无内容置灰(v0.2 入口规则)。
  let draft = ''
  try {
    const input = props.useInput ? (props.useInput((s: unknown) => s) as { draft?: unknown }) : undefined
    if (typeof input?.draft === 'string') draft = input.draft
  } catch { /* store 不可用时按空处理 */ }
  const ready = draft.trim() !== ''
  const [menu, setMenu] = useState(false)
  // 增强菜单:双入口共用草稿门(ADR-0028 反转 ADR-0025 可达性:空草稿整钮禁用)。
  // - 辩论:草稿是辩题起点,建单成功后清空输入框。
  // - 多仓任务:草稿是任务描述起点,TaskDialog 预填可改,草稿留给用户自己发。
  const openDebate = (): void => {
    setMenu(false)
    if (!ready) {
      // 防线:调用方保证输入框有内容才点菜单,空草稿直接关菜单不建空单。
      return
    }
    // 只读不清空:内容进对话框起点展示,等点"开始辩论"建单成功后才清空输入框。
    prefillQuestion = draft.trim()
    openPanel?.()
  }
  const openTask = (): void => {
    setMenu(false)
    if (!ready) return
    // 草稿收进任务描述起点(面板可改);草稿不清,留给用户自己发。
    prefillTaskDesc = draft.trim()
    openTaskPanel?.()
  }
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(false) }
    // 失焦关闭:点菜单容器外面就关(输入框打字不触发 pointerdown,另由草稿变化关)。
    const onDown = (e: PointerEvent): void => {
      const el = (e.target as Element | null)?.closest?.(`.${styles['dshe-enhance'] ?? 'dshe-enhance'}`)
      if (!el) setMenu(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [menu])
  // 输入框一打字就关菜单:菜单开着时草稿变了,"创建辩论"会收走旧草稿,不如关了重开。
  // 用 ref 比对(不能把 menu 放进依赖,否则开菜单瞬间又被关掉)。
  const prevDraft = useRef(draft)
  useEffect(() => {
    if (prevDraft.current !== draft) {
      prevDraft.current = draft
      setMenu(false)
    }
  })
  return (
    <span className={C('dshe-enhance')}>
      <button
        type="button"
        className={C('dshe-dockbtn')}
        title={ready ? '增强会话:创建辩论 / 建多仓任务' : '先在输入框写下任务或问题,再点增强会话'}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
        disabled={!ready}
      ><span>✦ 增强会话</span></button>
      {menu && (
        <span className={C('dshe-menu')} role="menu">
          <button
            type="button" role="menuitem"
            className={C('dshe-menuitem')}
            title="以输入框内容为起点创建辩论"
            onClick={openDebate}
          ><span>⚔ 创建辩论</span></button>
          <button
            type="button" role="menuitem"
            className={C('dshe-menuitem')}
            title="建多仓任务:扫描结构 → 建任务目录 → 拉起执行会话"
            onClick={openTask}
          ><span>📦 建多仓任务</span></button>
        </span>
      )}
    </span>
  )
}

/** 输入桥:捕获 sessionId + inputActions(建单直驱 + 建单后清空输入框);同时渲染输入框内小按钮。 */
function InputEntry(props: { useInput?: (s: unknown) => unknown; inputActions?: InputActs; sessionId?: unknown }): React.ReactNode {
  const actions = props.inputActions
  const scopedSid = resolveSessionId(props.sessionId)
  if (scopedSid !== '') currentSid = scopedSid
  useEffect(() => {
    if (actions && typeof actions.setDraft === 'function') {
      bridgeInsert = (text: string) => {
        try {
          actions.setDraft(text)
        } catch { /* 忽略 */ }
      }
      clearDraftOnStart = () => {
        try { actions.setDraft('') } catch { /* 忽略 */ }
      }
    }
    return () => { bridgeInsert = null; clearDraftOnStart = null }
  }, [actions])
  return <InputButton useInput={props.useInput} inputActions={props.inputActions} />
}

/** 扫描条目(host /api/task/scan 原样)。 */
interface TaskRepo {
  relPath: string
  absPath?: string
  kind: 'repo' | 'part' | 'external' | 'unknown'
  gitRoot?: string | null
  reason?: string
  aliases?: string[]
}

/**
 * 多仓任务面板(ADR-0028):scan → recommend → 审核勾选 → build → 预览 → launch。
 * - 任务描述来自输入框草稿(入口保证非空),面板可改,[重新推荐]重跑。
 * - scan 只展示结构不勾选;recommend 按描述推荐涉及仓,预勾选 + 理由展示,用户审核。
 * - recommend 失败/判不出 → 空选 + 提示手勾,不阻塞。
 * - 原生发送键不可拦截:任务启动必须点面板里的「建任务并预览会话」。
 * - 草稿不收走:任务描述走面板表单,草稿留给用户自己发。
 */
function TaskDialog(props: { onClose: () => void; useSessions?: (s: unknown) => unknown }): React.ReactNode {
  const prefs = loadTaskPrefs()
  // cwd 三路(与 DebateDialog 同口径):快照 byId 优先,sessionCwd 服务线次之,都不通才空。
  // 主键用 currentSid(input.right 注入的 sessionId,模块级缓存):0.2.0 快照已无 current,
  // 只看 snap.current 在新宿主上永远取不到(之前两次修法都漏了这一路,故仍报"没有工作区")。
  let liveSid = currentSid
  let liveCwd: string | null = sessionCwd
  try {
    const snap = props.useSessions ? (props.useSessions((s: unknown) => s) as { current?: unknown; byId?: Record<string, { cwd?: unknown }> }) : undefined
    if (typeof snap?.current === 'string' && snap.current !== '') liveSid = snap.current
    const cur = snap?.byId?.[liveSid]
    if (typeof cur?.cwd === 'string' && cur.cwd !== '') liveCwd = cur.cwd
  } catch { /* store 不可用时用 input.right + 服务线缓存 */ }
  // 父目录默认只用当前会话 cwd(用户拍板):偏好里的旧值跨工程会串台,直接忽略。
  const [parentRoot, setParentRoot] = useState(defaultParentRoot(liveCwd))
  // 任务描述:入口收草稿(prefillTaskDesc),面板可改;recommend 按它推荐涉及仓。
  const [desc, setDesc] = useState(prefillTaskDesc)
  const [repos, setRepos] = useState<TaskRepo[] | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [slug, setSlug] = useState('')
  // 任务描述即标题(ADR-0029):directive/to 的标题位直接用描述(超长截 80),
  // 一句话标题字段已删,不再维护 title/autoTitle。
  const [tasksRoot, setTasksRoot] = useState(prefs.tasksRoot)
  const [templateDir, setTemplateDir] = useState(prefs.templateDir)
  const [provider, setProvider] = useState(prefs.provider)
  const [model, setModel] = useState(prefs.model)
  const [taskDir, setTaskDir] = useState<string | null>(null)
  const [preview, setPreview] = useState<Array<{ repo: string; cwd: string }> | null>(null)
  const [sessions, setSessions] = useState<Array<{ repo: string; ok: boolean; sessionId?: string; error?: string }> | null>(null)
  const [backs, setBacks] = useState<Array<{ file: string; text: string }> | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  // provider/model 下拉数据(ADR-0032):llm 服务给列表;取不到就是接线缺陷,报错不退化。
  const [modelsInfo, setModelsInfo] = useState<{
    ok: boolean
    providers: Array<{ id: string; name: string }>
    models: Array<{ provider: string; id: string; name: string }>
    providerErrors: Array<{ provider: string; error: string }>
    current: { provider: string; model: string } | null
    error?: string
  } | null>(null)
  const [scannedRoot, setScannedRoot] = useState('')
  const [recommendedDesc, setRecommendedDesc] = useState('')
  // 推荐失败现场(ADR-0030):候选清单 + 模型原文,折叠展示,说清"为什么没挑出来"。
  const [recFail, setRecFail] = useState<{ reason: string; candidates: string[]; descriptors: Record<string, string>; rawHead: string; stopReason?: string; rawLen?: number } | null>(null)

  const toggle = (rel: string): void => {
    setChecked((prev) => (prev.includes(rel) ? prev.filter((r) => r !== rel) : [...prev, rel]))
  }

  const scan = async (root: string): Promise<void> => {
    if (root === '') { setError('当前会话没有工作区:先在目标父目录的会话里打开面板'); return }
    setBusy('扫描中…'); setError(null); setRepos(null); setChecked([]); setReasons({}); setPreview(null)
    try {
      const r = await api<{ ok: boolean; repos?: TaskRepo[]; error?: string }>('task/scan', { parentRoot: root })
      if (!r.ok) { setError(r.error ?? 'scan failed'); return }
      const found = r.repos ?? []
      setRepos(found)
      setScannedRoot(root)
      // ADR-0029:scan 只展示结构;slug 由任务描述/AI 标题定,不再从父目录取。
      // 占位回 task,等 recommend 按描述/AI 标题覆盖。
      setSlug('task')
      // 任务根目录没填就落到默认 .tasks(不再靠「默认 .tasks」按钮提示)。
      if (tasksRoot.trim() === '') setTasksRoot(suggestTasksRoot(root))
      saveTaskPrefs({ parentRoot: root, tasksRoot, templateDir, provider, model })
      // 扫完即推荐:任务描述来自输入框草稿(入口保证非空)。
      await recommend(found)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  const recommend = async (found: TaskRepo[]): Promise<void> => {
    const text = desc.trim()
    if (text === '') { setError('先写任务描述(输入框草稿会自动带入)再推荐'); return }
    setBusy('AI 推荐中…'); setError(null)
    setRecommendedDesc(text)
    try {
      const r = await api<{ ok: boolean; recommended?: string[]; reasons?: Record<string, string>; title?: string; slug?: string; error?: string; stopReason?: string; rawLen?: number; rawHead?: string; knownCount?: number; candidates?: string[]; descriptors?: Record<string, string> }>(
        'task/recommend',
        {
          description: text,
          repos: found.map((x) => ({ relPath: x.relPath, kind: x.kind, absPath: x.absPath ?? '' })),
          parentRoot: parentRoot.trim(),
          sid: liveSid,
        },
      )
      if (!r.ok) {
        // 判不出/调用失败/空推荐 → 空选 + 说清原因(ADR-0030),不阻塞;slug 回退描述启发。
        setChecked([]); setReasons({})
        setRecFail({
          reason: r.error ?? 'unknown',
          candidates: r.candidates ?? found.filter((x) => x.kind === 'repo' || x.kind === 'part').map((x) => x.relPath),
          descriptors: r.descriptors ?? {},
          rawHead: r.rawHead ?? '',
          stopReason: r.stopReason,
          rawLen: r.rawLen,
        })
        setError(`AI 推荐未给出结果:${r.error ?? 'unknown'} —— 已清空勾选,请按下面候选手动勾选`)
        setSlug(suggestSlugFromText(text))
        return
      }
      setRecFail(null)
      const merged = applyRecommendDefaults(found, r.recommended ?? [])
      setChecked(merged.checked)
      setReasons(r.reasons ?? {})
      // slug:AI 给的缩写优先(它看得懂中文任务),没有才回落到词表启发(ADR-0033)。
      const aiSlug = String(r.slug ?? '').trim()
      const aiTitle = String(r.title ?? '').trim()
      setSlug(aiSlug !== '' ? aiSlug : suggestSlugFromText(aiTitle !== '' ? aiTitle : text))
    } catch (e) {
      setChecked([]); setReasons({})
      setRecFail({ reason: `请求失败:${String(e)}`, candidates: [], descriptors: {}, rawHead: '' })
      setError(`AI 推荐请求失败(fetch 层):${String(e)} —— 已清空勾选请手动勾选`)
      setSlug(suggestSlugFromText(desc.trim()))
    } finally {
      setBusy('')
    }
  }

  // 打开面板即扫一次:父目录=当前会话 cwd(首扫用 liveCwd 快照,不等服务线),无需点按钮。
  const autoScanned = useRef(false)
  useEffect(() => {
    if (autoScanned.current) return
    autoScanned.current = true
    void scan(defaultParentRoot(liveCwd))
    void (async () => {
      try {
        const m = await api<{
          ok: boolean
          providers?: Array<{ id: string; name: string }>
          models?: Array<{ provider: string; id: string; name: string }>
          providerErrors?: Array<{ provider: string; error: string }>
          current?: { provider: string; model: string } | null
          error?: string
        }>('task/models', {})
        setModelsInfo({
          ok: m.ok,
          providers: m.providers ?? [],
          models: m.models ?? [],
          providerErrors: m.providerErrors ?? [],
          current: m.current ?? null,
          error: m.error,
        })
        // 首次把宿主当前选择回显到下拉,避免用户以为必须重选。
        if (m.ok && m.current) {
          setProvider((prev) => (prev === '' ? m.current!.provider : prev))
          setModel((prev) => (prev === '' ? m.current!.model : prev))
        }
      } catch (e) {
        setModelsInfo({ ok: false, providers: [], models: [], providerErrors: [], current: null, error: String(e) })
      }
    })()
  }, [])

  /** 父目录改了才重扫(替代「重新扫描」按钮):失焦或回车触发,值没变不打扰。 */
  const rescanIfChanged = (): void => {
    const root = parentRoot.trim()
    if (root === '' || root === scannedRoot) return
    void scan(root)
  }

  const build = async (): Promise<void> => {
    const involved = checked
    const err = validateTaskBuild({ slug, involved, tasksRoot: tasksRoot.trim() !== '' ? tasksRoot.trim() : suggestTasksRoot(parentRoot.trim()) })
    if (err !== null) { setError(err); return }
    const finalTasksRoot = tasksRoot.trim() !== '' ? tasksRoot.trim() : suggestTasksRoot(parentRoot.trim())
    setBusy('建任务目录中…'); setError(null); setTaskDir(null); setPreview(null); setSessions(null); setBacks(null)
    try {
      // 任务描述即标题(ADR-0029):directive/to 的标题位直接用描述,超长截 80。
      const titleText = desc.trim().length > 80 ? `${desc.trim().slice(0, 80)}…` : desc.trim()
      const r = await api<{ ok: boolean; taskDir?: string; error?: string }>('task/build', {
        slug: slug.trim(), involved, title: titleText !== '' ? titleText : slug.trim(),
        tasksRoot: finalTasksRoot,
        parentRoot: parentRoot.trim() !== '' ? parentRoot.trim() : undefined,
        templateDir: templateDir.trim() !== '' ? templateDir.trim() : undefined,
        ...(provider.trim() !== '' || model.trim() !== '' ? {} : {}),
      })
      if (!r.ok || !r.taskDir) { setError(r.error ?? 'build failed'); return }
      setTaskDir(r.taskDir)
      setTasksRoot(finalTasksRoot)
      // 建目录成功即进预览:逐仓列出将建会话(仓→cwd→provider/model),确认才真正 launch。
      const root = parentRoot.trim()
      const prov = provider.trim() !== '' ? provider.trim() : '(宿主默认)'
      const mod = model.trim() !== '' ? model.trim() : '(宿主默认)'
      setPreview(involved.map((repo) => ({ repo, cwd: `${root}/${repo} · ${prov} / ${mod}` })))
      saveTaskPrefs({ parentRoot: parentRoot.trim(), tasksRoot: finalTasksRoot, templateDir, provider, model })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  const launch = async (): Promise<void> => {
    if (taskDir === null) { setError('先建任务目录'); return }
    // 确认即签发:用户在预览里已确认,直接 launch 带 skipIssuedCheck(直发);
    // directive 照常写盘留痕,不再要求人手改 issued。
    setBusy('拉起执行会话中…'); setError(null); setSessions(null)
    try {
      const r = await api<{ ok: boolean; sessions?: Array<{ repo: string; ok: boolean; sessionId?: string; error?: string }>; error?: string }>('task/launch', {
        taskDir, involved: checked, parentRoot: parentRoot.trim(),
        provider: provider.trim() !== '' ? provider.trim() : undefined,
        model: model.trim() !== '' ? model.trim() : undefined,
        skipIssuedCheck: true,
      })
      if (!r.ok) { setError(r.error ?? 'launch failed'); return }
      setSessions(r.sessions ?? [])
      setPreview(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  const collect = async (): Promise<void> => {
    if (taskDir === null) { setError('先建任务目录'); return }
    setBusy('汇总回信中…'); setError(null); setBacks(null)
    try {
      const r = await api<{ ok: boolean; backs?: Array<{ file: string; text: string }>; error?: string }>('task/collect', { taskDir })
      if (!r.ok) { setError(r.error ?? 'collect failed'); return }
      setBacks(r.backs ?? [])
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  const verdict = validateTaskBuild({
    slug,
    involved: checked,
    tasksRoot: tasksRoot.trim() !== '' ? tasksRoot.trim() : suggestTasksRoot(parentRoot.trim()),
  })
  // 只把能当任务落点的仓列出来(ADR-0031):unknown/external 不是仓,列出来也没法全选。
  const usableRepos = (repos ?? []).filter((r) => r.kind === 'repo' || r.kind === 'part')
  const ignoredRepos = (repos ?? []).filter((r) => r.kind !== 'repo' && r.kind !== 'part')
  const listReady = modelsInfo?.ok === true
  const providerModels = (modelsInfo?.models ?? []).filter((m) => provider === '' || m.provider === provider)
  const providerListError = provider === ''
    ? undefined
    : modelsInfo?.providerErrors.find((e) => e.provider === provider)
  // 该 provider 明确不广告模型(适配器能力所限)才允许手填 id;其余情况一律只能选。
  const manualModelAllowed = provider !== '' && providerModels.length === 0 && providerListError !== undefined
  return (
    <div className={C('dshe-overlay')} role="dialog" aria-label="多仓任务">
      <div className={C('dshe-header')}>
        <span>📦 多仓任务</span>
        <span className={C('spacer')} />
        <button className={C('dshe-close')} onClick={props.onClose} aria-label="关闭">✕</button>
      </div>
      <div className={C('dshe-body')}>
        {/* 忙/错条固定贴顶(不随内容滚走):探测、推荐、建材料、拉起、汇总全在这里报进度。 */}
        {(busy !== '' || error !== null) && (
          <div className={C('dshe-statusbar')}>
            {busy !== '' && (
              <div className={C('dshe-busyrow')}>
                <span className={C('dshe-spinner')} aria-hidden="true" />
                <span>{busy}</span>
              </div>
            )}
            {busy === '' && error !== null && <div className={C('dshe-error')}>{error}</div>}
          </div>
        )}
        <div className={C('dshe-note')}>打开自动扫描当前会话目录 → AI 按任务描述推荐涉及仓 → 你审核勾选 → 确认拉起(原生回车只发消息,不触发任务)。</div>
        <div className={C('dshe-field')}>
          <span>任务描述(AI 按它推荐涉及仓,改完失焦即重推)</span>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              if (repos === null) return
              if (desc.trim() === '' || desc.trim() === recommendedDesc) return
              void recommend(repos)
            }}
            placeholder="如 清理本文件夹下所有的 .tmp"
            rows={3}
          />
        </div>
        <div className={C('dshe-field')}>
          <span>父目录(换目录后失焦即重扫)</span>
          <input
            type="text"
            value={parentRoot}
            onChange={(e) => setParentRoot(e.target.value)}
            onBlur={rescanIfChanged}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rescanIfChanged() } }}
            placeholder="如 D:/Users/xxx/Documents/finance"
          />
        </div>
        {repos !== null && (
          <div className={C('dshe-field')}>
            <span>扫描结果(AI 推荐已预勾选,逐项审核)</span>
            <div className={C('dshe-checklist')}>
              {usableRepos.map((r) => (
                <label key={r.relPath} className={C('dshe-checkrow')}>
                  <input type="checkbox" checked={checked.includes(r.relPath)} onChange={() => toggle(r.relPath)} />
                  <span className={C('dshe-checkpath')}>{r.relPath}</span>
                  <span className={C('dshe-checkkind')}>{r.kind}</span>
                  {reasons[r.relPath] && (
                    <span className={C('dshe-checkreason')}>AI:{reasons[r.relPath]}</span>
                  )}
                </label>
              ))}
            </div>
            {usableRepos.length === 0 && <div className={C('dshe-note')}>空目录:换个父目录再扫。</div>}
            {ignoredRepos.length > 0 && (
              <div className={C('dshe-note')}>
                已忽略 {ignoredRepos.length} 个非仓目录:{ignoredRepos.map((r) => r.relPath).join('、')}
              </div>
            )}
            {usableRepos.length > 0 && (
              <div className={C('dshe-actions')}>
                <button
                  type="button"
                  className={C('dshe-copybtn')}
                  onClick={() => setChecked(usableRepos.map((r) => r.relPath))}
                >
                  全选可用仓
                </button>
                <button type="button" className={C('dshe-copybtn')} onClick={() => setChecked([])}>全不选</button>
                <span className={C('dshe-note')}>已选 {checked.length} / 可用 {usableRepos.length}</span>
              </div>
            )}
          </div>
        )}
        {recFail !== null && (
          <div className={C('dshe-recfail')}>
            <div><b>AI 为什么没挑出来:</b>{recFail.reason}</div>
            {recFail.candidates.length > 0 && (
              <div className={C('dshe-note')}>候选:{recFail.candidates.join('、')}</div>
            )}
            <details>
              <summary className={C('dshe-note')}>
                模型原文与候选自述(stop={recFail.stopReason ?? '?'} rawLen={recFail.rawLen ?? '?'})
              </summary>
              <pre className={C('dshe-rawpre')}>{recFail.rawHead || '(无原文)'}</pre>
              {Object.keys(recFail.descriptors).length > 0 && (
                <pre className={C('dshe-rawpre')}>
                  {Object.entries(recFail.descriptors).map(([k, v]) => `${k} — ${v}`).join('\n')}
                </pre>
              )}
            </details>
          </div>
        )}
        <div className={C('dshe-field')}>
          <span>slug(任务英文缩写:2-3 个词、≤20 字符,AI 按描述拟,可改)</span>
          <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="如 cleanup-tmp" />
        </div>
        <div className={C('dshe-field')}>
          <span>任务目录(将创建)</span>
          <div className={C('dshe-taskdir')}>
            {(tasksRoot.trim() !== '' ? tasksRoot.trim().replace(/[\\/]+$/, '') : '<任务根目录>')}/{(slug.trim() !== '' ? slug.trim() : '<slug>')}-&lt;时间戳&gt;
          </div>
          <div className={C('dshe-note')}>
            directive.md(总指示)+ 每个涉及仓一份 to-&lt;仓&gt;.md(派活)都落在这里。
          </div>
        </div>
        <details className={C('dshe-adv')}>
          <summary className={C('dshe-note')}>高级:任务根目录与自定义模板</summary>
          <div className={C('dshe-field')}>
            <span>任务根目录(缺省 &lt;父目录&gt;/.cross-tasks)</span>
            <input type="text" value={tasksRoot} onChange={(e) => setTasksRoot(e.target.value)} />
          </div>
          <div className={C('dshe-field')}>
            <span>模板目录(留空用内建模板)</span>
            <input type="text" value={templateDir} onChange={(e) => setTemplateDir(e.target.value)} placeholder="含 directive_template.md / to_template.md 的编排库" />
          </div>
          <div className={C('dshe-note')}>
            模板是产出物的骨架:directive_template.md 出总指示(填 slug/version/involved/标题…),
            to_template.md 出每仓派活(填 to/slug/directive/created/一句话)。内建模板已够跑,
            只有你有自家仓库模板规范时才需要指目录。
          </div>
        </details>
        {modelsInfo === null && <div className={C('dshe-note')}>provider/model 列表加载中…</div>}
        {modelsInfo !== null && !modelsInfo.ok && (
          <div className={C('dshe-recfail')}>
            <div><b>provider/model 列表获取失败:</b>{modelsInfo.error ?? 'unknown'}</div>
            <div className={C('dshe-note')}>
              这是接线缺陷(宿主 Context.llm 应提供 listProviders/listModels),不是需要手填的理由;
              在修好之前只能用宿主默认。
            </div>
          </div>
        )}
        <div className={C('dshe-row')}>
          <div className={C('dshe-field')}>
            <span>provider</span>
            <select
              value={provider}
              disabled={!listReady}
              onChange={(e) => { setProvider(e.target.value); setModel('') }}
            >
              <option value="">宿主默认{modelsInfo?.current ? `(${modelsInfo.current.provider})` : ''}</option>
              {(modelsInfo?.providers ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className={C('dshe-field')}>
            <span>model</span>
            <select
              value={manualModelAllowed ? '' : model}
              disabled={!listReady || providerModels.length === 0}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">宿主默认{modelsInfo?.current ? `(${modelsInfo.current.model})` : ''}</option>
              {providerModels.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={m.id}>
                  {provider === '' ? `${m.provider}/${m.name}` : m.name}
                </option>
              ))}
            </select>
            {manualModelAllowed && (
              <>
                <div className={C('dshe-note')}>
                  该 provider 未广告模型清单({providerListError?.error}),只能手填 model id:
                </div>
                <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 opencode-muse-spark-1.3" />
              </>
            )}
          </div>
        </div>
        {verdict !== null && <div className={C('dshe-note')}>待填:{verdict}</div>}
        <div className={C('dshe-actions')}>
          <div className={C('dshe-btnrow')}>
            <button className={C('dshe-start')} onClick={() => { void build() }} disabled={busy !== '' || verdict !== null}>{busy !== '' ? busy : '建任务并预览会话'}</button>
            <button className={C('dshe-start')} onClick={props.onClose} disabled={busy !== ''}>取消</button>
          </div>
        </div>
        {taskDir !== null && (
          <div className={C('dshe-resolved')}>
            <div><b>任务目录:</b>{taskDir}</div>
            <div className={C('dshe-note')}>材料已写盘(directive 默认 issued,确认即拉起)。</div>
          </div>
        )}
        {preview !== null && (
          <div className={C('dshe-field')}>
            <span>将建立 {preview.length} 个执行会话(确认后拉起)</span>
            <div className={C('dshe-checklist')}>
              {preview.map((p) => (
                <div key={p.repo} className={C('dshe-previewrow')}>
                  <span className={C('dshe-checkpath')}>{p.repo}</span>
                  <span className={C('dshe-note')}>{p.cwd}</span>
                </div>
              ))}
            </div>
            <div className={C('dshe-actions')}>
              <button className={C('dshe-start')} onClick={() => { void launch() }} disabled={busy !== ''}>{busy !== '' ? busy : '确认拉起'}</button>
            </div>
          </div>
        )}
        {sessions !== null && (
          <div className={C('dshe-resolved')}>
            {sessions.map((s) => (
              <div key={s.repo}><b>{s.repo}</b>: {s.ok ? `会话 ${s.sessionId ?? ''}(去会话列表跟进)` : `失败:${s.error ?? ''}`}</div>
            ))}
          </div>
        )}
        {taskDir !== null && (
          <div className={C('dshe-actions')}>
            <button className={C('dshe-stop')} onClick={() => { void collect() }} disabled={busy !== ''}>汇总回信</button>
          </div>
        )}
        {backs !== null && (
          <div className={C('dshe-resolved')}>
            <div><b>回信 {backs.length} 封</b></div>
            {backs.map((b) => (
              <div key={b.file}><b>{b.file}</b><div className={C('dshe-note')}>{b.text.split('\n').slice(0, 3).join('\n')}</div></div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsView(): React.ReactNode {
  const tr = useTr()
  return (
    <div>
      <h3>⚔ {tr('panel.title')}</h3>
      <p>{tr('settings.note')}</p>
      <p>{tr('version', { ver: BUILD_VERSION })}</p>
    </div>
  )
}

interface SlotsLike {
  inject(name: string, fn: () => unknown): void
  register(options: {
    name: string
    id: string
    order?: number
    label?: string | (() => string)
    inject?: (sessionId?: string) => Record<string, unknown>
  }, component: (props: never) => React.ReactNode): unknown
}
// 模块级会话 cwd 缓存:ctx.inject(['sessions']) 服务线直读(0.2.0 slot 传的 useSessions 已无 current)。
// 面板 start() 用它当 cwd,不再靠 overlay 快照。
let sessionCwd: string | null = null

interface CtxLike {
  get(name: string): unknown
  inject(names: string[], fn: (scope: unknown) => (() => void) | void): void
  effect(fn: () => () => void): void
}

export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: CtxLike): void {
  const slots = ctx.get('slots') as SlotsLike | undefined
  if (slots === undefined) return
  const locale = ctx.get('locale') as { register(ns: string, locale: string, dict: Record<string, string>): () => void } | undefined
  if (locale !== undefined) {
    try {
      ctx.effect(() => {
        const d1 = locale.register(NS, 'zh', DICTS.zh)
        const d2 = locale.register(NS, 'en', DICTS.en)
        return () => { d1(); d2() }
      })
    } catch {
      // locale 不可用时静默忽略
    }
  }
  // 唯一入口:输入框内小按钮(不占整行)+ overlay 浮层对话框。header 胶囊已摘除。
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'enhance-panel' },
    (props: never) => <DebateRoot {...(props as { useSessions?: (s: unknown) => unknown })} />,
  ))
  slots.inject('conversation.input.right', () => slots.register(
    {
      name: 'conversation.input.right',
      id: 'enhance-entry',
      order: 100,
      label: () => '✦ 增强(辩论/多仓任务)',
      // 增强菜单(ADR-0025):不再独占叫"辩论",两项走 overlay 面板显式按钮。
      // Session scope invokes this with the current session ID. The slot's
      // renderSlot call intentionally has no owner props, so props.sessionId
      // is not populated unless we use the registration injection contract.
      inject: (sessionId) => ({ sessionId }),
    },
    (props: never) => <InputEntry {...(props as { useInput?: (s: unknown) => unknown; inputActions?: { setDraft(d: string): void }; sessionId?: unknown })} />,
  ))
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'enhance', order: 31, label: () => '会话增强' },
    () => <SettingsView />,
  ))
  // 会话 cwd 服务线直读(照抄 explorer):slot 传的 useSessions 在 0.2.0 已无 current,
  // 改走 sessions.list.getSnapshot(),start() 建单时当 cwd 传给 host。
  try {
    ctx.inject(['sessions'], (scope) => {
      const sessions = (scope as unknown as { sessions?: { list: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { current?: string; byId?: Record<string, { cwd?: unknown }> } } } }).sessions
      if (sessions === undefined) return
      const update = (): void => {
        try {
          const snap = sessions.list.getSnapshot()
          const cur = typeof snap.current === 'string' ? snap.byId?.[snap.current] : undefined
          sessionCwd = typeof cur?.cwd === 'string' && cur.cwd !== '' ? cur.cwd : null
        } catch { /* 快照失败时保持旧值 */ }
      }
      update()
      return sessions.list.subscribe(update)
    })
  } catch {
    // sessions 服务不可用时静默忽略(cwd 回空,host 用进程目录)
  }
}
