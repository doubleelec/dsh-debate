/**
 * dsh-debate — Client 半区(v0.1)。
 *
 * 只用按钮,不用命令:会话 header 胶囊按钮 + 输入框 dock 小按钮,点开同一个
 * shell.overlay 全配置对话框(问题/题型/lens/双模型/轮数/裁判),一目了然。
 * 建单走 /dsh-debate/api/start,轮询 /dsh-debate/api/state 取实况。
 * 执行由模型调 debate_run 工具完成(面板提示用户发一句话触发)。
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
  DIALOG_DEFAULT_H, DIALOG_DEFAULT_W,
  clampDialogHeight, clampDialogWidth, clampStoredHeight, clampStoredWidth,
  loadManualHeight, loadManualWidth, saveManualHeight, saveManualWidth,
} from './dialogLayout'

const C = (k: string): string => styles[k] ?? k

// ---------- 与 Host 的 JSON RPC ----------
async function api<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/dsh-debate/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json() as Promise<T>
}

// ---------- 国际化 ----------
const NS = 'dsh-debate'
const DICTS: Record<string, Record<string, string>> = {
  zh: {
    'panel.title': '双视角辩论', 'tip': '为开放性问题跑建构 / 挑战 / 制图,产出成果地图',
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
    'btn.start': '开始辩论', 'btn.stop': '停止', 'btn.close': '关闭',
    'st.idle': '就绪', 'st.running': '辩论进行中…(host 后台直驱,开题/交锋/地图自动进面板)',
    'st.polling': '等待模型执行…', 'st.done': '已完成', 'st.failed': '失败', 'st.stopped': '已停止',
    'draft.hint': '跑完后可复制成果地图回输入框',
    'trigger.copy': '复制成果地图', 'trigger.copied': '已复制,去输入框粘贴',
    'map.lenses': '视角清单', 'map.args': '论证表', 'map.grounding': '依据表',
    'map.disputes': '分歧地图', 'map.gaps': '缺口清单',
    'settings.nav': '辩论', 'settings.note': '默认模型与轮数(面板每次可改)。',
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
    'panel.title': 'Two-lens debate', 'tip': 'Builder / challenger / synthesizer map for open questions',
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
    'btn.start': 'Start debate', 'btn.stop': 'Stop', 'btn.close': 'Close',
    'st.idle': 'Ready', 'st.running': 'Debate running… (host drives open → rounds → map into the panel)',
    'st.polling': 'Waiting for model…', 'st.done': 'Done', 'st.failed': 'Failed', 'st.stopped': 'Stopped',
    'draft.hint': 'Copy the result map back to the composer when done',
    'trigger.copy': 'Copy result map', 'trigger.copied': 'Copied — paste in composer',
    'map.lenses': 'Lenses', 'map.args': 'Arguments', 'map.grounding': 'Grounding',
    'map.disputes': 'Disputes', 'map.gaps': 'Gaps',
    'settings.nav': 'Debate', 'settings.note': 'Default models and rounds (overridable per run).',
    'version': 'Version v{ver}',
    'btn.fullscreen': 'Fullscreen', 'btn.unfullscreen': 'Exit fullscreen', 'btn.minimize': 'Minimize',
    'btn.restore': 'Restore', 'resize.tip': 'Drag from the corner to resize, double-click to reset',
    'minimized.running': 'Debate running…', 'minimized.done': 'Debate finished',
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
    'decision.title': 'Debate conclusion (paste-ready)',
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
let prefillQuestion = ''
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
  const [rounds, setRounds] = useState(5)
  // 跟局 id:聊天开局后模型返回的会话 id,面板粘贴即看实况。
  const [followId, setFollowId] = useState('')
  // targetCwd 面板不再露:聊天开局(debate_start)自动继承会话 cwd;HTTP 建单默认进程目录。
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
        const res = await fetch('/dsh-debate/api/version', {
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
        maxRounds: rounds,
        hint,
        sid: liveSid,
        cwd: liveCwd,
      })
      if (!r.ok || !r.id) { setError(r.error ?? 'start failed'); return }
      try { clearDraftOnStart?.() } catch { /* 忽略 */ }
      prefillQuestion = ''
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
      <button className={C('dshd-mini')} onClick={() => setMinimized(false)} title={tr('btn.restore')} aria-label={tr('btn.restore')}>
        <span className={C(status === 'running' ? 'dot-live' : 'dot-done')} />
        <span>⚔ {miniLabel}</span>
        <span className={C('dshd-version') + (versionWarn !== null ? ` ${C('dshd-version-warn')}` : '')} title={versionTip}>{versionText}{versionWarn !== null ? ' ⚠' : ''}</span>
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
      className={C('dshd-overlay') + (fullscreen ? ` ${C('dshd-overlay-full')}` : '')}
      role="dialog" aria-label={tr('panel.title')}
      style={overlayStyle}
    >
      <div className={C('dshd-header')}>
        <span>⚔ {tr('panel.title')}</span>
        <span className={C('dshd-version') + (versionWarn !== null ? ` ${C('dshd-version-warn')}` : '')} title={versionTip}>{versionText}{versionWarn !== null ? ' ⚠' : ''}</span>
        <span className={C('spacer')} />
        <button className={C('dshd-hbtn')} onClick={toggleFullscreen} title={fullscreen ? tr('btn.unfullscreen') : tr('btn.fullscreen')} aria-label={fullscreen ? tr('btn.unfullscreen') : tr('btn.fullscreen')}>{fullscreen ? '⤢' : '⛶'}</button>
        <button className={C('dshd-hbtn')} onClick={() => setMinimized(true)} title={tr('btn.minimize')} aria-label={tr('btn.minimize')}>—</button>
        <button className={C('dshd-close')} onClick={props.onClose} aria-label={tr('btn.close')}>✕</button>
      </div>
      <div className={C('dshd-body')}>
        <div className={C('dshd-note')}>{tr('auto.note')}</div>
        {/* 版本告警(v0.4):后台不是最新代码时明确说清楚,别让徽标骗人。 */}
        {versionWarn !== null && (
          <div className={C('dshd-verwarn')} role="alert">
            <b>{tr('ver.warnTitle')}</b>
            <span>{versionWarn}</span>
          </div>
        )}
        {/* 实况进度置顶:谁在写一眼可见 */}
        {progress !== '' && (status === 'running' || status === 'done') && (
          <div className={C('dshd-livebar')}>
            <span className={C(status === 'running' ? 'dot-live' : 'dot-done')} />
            <span>{progress}</span>
          </div>
        )}
        {status === 'running' && (writing('builder') || writing('challenger') || writing('synthesizer')) && (
          <div className={C('dshd-note')}>
            {writing('builder') && '✍ 建构者正在写…'}
            {writing('challenger') && '✍ 挑战者正在写…'}
            {writing('synthesizer') && '✍ 制图员正在写…'}
          </div>
        )}
        {prefillQuestion.trim() !== '' && (
          <div className={C('dshd-resolved')}>
            <div><b>{tr('auto.question')}</b>{prefillQuestion.trim()}</div>
          </div>
        )}
        <div className={C('dshd-field')}>
          <span>{tr('builder.label')}</span>
          <select value={builder} onChange={(e) => setBuilder(Number(e.target.value))} disabled={status === 'running'}>
            {MODELS.map((m, i) => <option key={i} value={i}>{routeLabel(m)}</option>)}
          </select>
        </div>
        <div className={C('dshd-field')}>
          <span>{tr('challenger.label')}</span>
          <select value={challenger} onChange={(e) => setChallenger(Number(e.target.value))} disabled={status === 'running'}>
            {MODELS.map((m, i) => <option key={i} value={i}>{routeLabel(m)}</option>)}
          </select>
        </div>
        <div className={C('dshd-field')}>
          <span>{tr('synth.label')}</span>
          <select value={synth} onChange={(e) => setSynth(Number(e.target.value))} disabled={status === 'running'}>
            {MODELS.map((m, i) => <option key={i} value={i}>{routeLabel(m)}</option>)}
          </select>
        </div>
        <div className={C('dshd-field')}>
          <span>{tr('rounds.label')}</span>
          <input type="number" min={1} max={10} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} disabled={status === 'running'} />
        </div>
        <div className={C('dshd-note')}>输入框写问题 → 点开始辩论即开(工作区自动取当前会话,不用填)。实况在本面板看,跑完点"复制成果地图"并回对话。</div>
        {resolved !== null && (
          <div className={C('dshd-resolved')}>
            <div><b>{tr('auto.question')}</b>{resolved.question}</div>
            <div><b>{tr('auto.type')}</b>{tr(`type.${resolved.questionType}`) ?? resolved.questionType} · {resolved.lenses}{tr('auto.lensesUnit')} · {tr('auto.ctx')}{resolved.contextChars}{tr('auto.charsUnit')}{resolved.targetCwd ? ` · 目标:${resolved.targetCwd}` : ''}</div>
          </div>
        )}
        {/* 收尾陈述(v4):辩论一结束就置顶。这是用户决定下一步的依据,所以单独一块、可一键复制。 */}
        {decision !== null && decision.trim() !== '' && (
          <div className={C('dshd-decision')}>
            <div className={C('dshd-decision-head')}>
              <span>{tr('decision.title')}</span>
              <button className={C('dshd-copybtn')} onClick={() => { void copyDecision() }}>{copied ? tr('trigger.copied') : tr('decision.copy')}</button>
            </div>
            <div className={C('dshd-decision-body')}>{decision.replace(/^##\s*[^\n]*\n?/, '').trim()}</div>
          </div>
        )}
        {/* 结论文档(ADR-0019):把"有地址的产物"摆出来——路径不给,文件就等于不存在。 */}
        {reportPath !== null && (
          <div className={C('dshd-report')}>
            <span>{tr('report.saved')}</span>
            <code title={reportPath}>{reportPath}</code>
            <button className={C('dshd-copybtn')} onClick={() => { void copyReportPath() }}>{copiedPath ? tr('trigger.copied') : tr('report.copy')}</button>
          </div>
        )}
        {/* 两条失败原因分开显示:落盘失败查存储后端,落文件失败查工作区权限。 */}
        {(persistError !== null || reportError !== null) && (
          <div className={C('dshd-verwarn')} role="alert">
            <b>{tr('report.warnTitle')}</b>
            {persistError !== null && <span>{tr('report.persistFail', { err: persistError })}</span>}
            {reportError !== null && reportError !== 'no-target-cwd' && <span>{tr('report.fileFail', { err: reportError })}</span>}
            {reportError === 'no-target-cwd' && <span>{tr('report.noCwd')}</span>}
          </div>
        )}
        {/* 恢复标记:宿主重启后旧局仍打得开,但要说清它是恢复的、且不会再跑。 */}
        {restored && (
          <div className={C('dshd-restored')}>{tr('report.restored')}</div>
        )}
        <div className={C('dshd-actions')}>
          {status === 'running' || status === 'polling'
            ? <button className={C('dshd-stop')} onClick={() => { void stop() }} disabled={status === 'polling'} title={status === 'polling' ? '等模型开局:输入框回车后自动跟局' : undefined}>{tr('btn.stop')}</button>
            : <button className={C('dshd-start')} onClick={() => { void start() }}>{tr('btn.start')}</button>}
          <span className={C('dshd-status')}>{tr(`st.${status}`)}</span>
        </div>
        {/* 跟局:本局 id(建单自动填);旧局 id 可手动粘贴回来重看。宿主重启后旧局不再作废——
            host 启动时会把磁盘上的整局记录装回内存(ADR-0019),所以粘贴旧 id 仍能取到结论。 */}
        {(status === 'idle' || status === 'polling' || status === 'stopped') && (
          <div className={C('dshd-field')}>
            <span>会话 id</span>
            <input type="text" value={followId} onChange={(e) => setFollowId(e.target.value)} placeholder="debate-…(本局自动填,旧局可粘贴)" />
            <div className={C('dshd-actions')}>
              <button className={C('dshd-start')} onClick={() => { void follow(followId) }} disabled={followId.trim() === ''}>跟局看实况</button>
            </div>
          </div>
        )}
        {sessionId !== null && status === 'running' && (
          <div className={C('dshd-note')}>
            <div className={C('dshd-sid')}>会话 {sessionId}</div>
          </div>
        )}
        {sessionId !== null && status === 'done' && turns.length > 0 && (
          <div className={C('dshd-field')}>
            <span>{tr('draft.hint')}</span>
            <div className={C('dshd-actions')}>
              <button className={C('dshd-stop')} onClick={copyMap}>{copied ? tr('trigger.copied') : tr('trigger.copy')}</button>
            </div>
          </div>
        )}
        {/* 停机审计:stopReason + 每轮人话小结(判定数据翻译,不调模型)。 */}
        {(stopReason !== null || roundAudits.length > 0) && (status === 'done' || status === 'running') && (
          <div className={C('dshd-resolved')}>
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
          <div className={C('dshd-note')}>
            {mirrorCount > 0 ? `${tr('mirror.on')} ×${mirrorCount}` : tr('mirror.off')}
            {mirrorError !== null ? ` · ${tr('mirror.fail')}:${mirrorError}` : ''}
          </div>
        )}
        {error !== null && <div className={C('dshd-error')}>{error}</div>}
        {/* 实时流:正在写的各方当前 turn 流式文本,打字机效果(结论落 transcript 即替换成正式 TurnCard)。 */}
        {status === 'running' && Object.keys(streams).map((role) => {
          const st = streams[role]
          if (!st || st.text === '') return null
          return <StreamCard key={`stream-${role}`} role={role} round={st.round} kind={st.kind} text={st.text} />
        })}
        {turns.length > 0 && (
          <div className={C('dshd-feed')} ref={feedRef} onScroll={onFeedScroll}>
            {turns.map((t) => (
              <TurnCard key={t.seq} turn={t} />
            ))}
          </div>
        )}
      </div>
      {/* 右下角拉手:拖拽调尺寸(宽高同时),双击恢复默认;全屏时拖动即退全屏 */}
      {!minimized && (
        <div
          className={C('dshd-resize-corner')}
          onMouseDown={onResizeDown} onTouchStart={onResizeTouchStart} onDoubleClick={onResizeReset}
          title={tr('resize.tip')} role="separator" aria-orientation="horizontal" aria-label={tr('resize.tip')}
        ><span className={C('dshd-resize-corner-bar')} /></div>
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
      <div className={C('dshd-turn-stream')}>
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
    <div className={C('dshd-turn-stream')}>
      <div className={C('who')}>{who}{tr('stream.writing')}</div>
      {rest !== '' ? <div>{tail(rest)}<span className={C('caret')}>▍</span></div> : (
        <>
          {summary !== '' && <div className={C('dshd-summary')}>{tail(summary)}<span className={C('caret')}>▍</span></div>}
          {delta !== '' && <div className={C('dshd-delta')}>Δ {delta.split('\n')[0]}</div>}
          {detail !== '' && <div className={C('dshd-note')}>{tail(detail)}</div>}
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
    <div className={C('dshd-turn')}>
      <div className={C('who')}>{roundLabel(t.round, t.role, tr)} · {roleName(t.role, tr)}</div>
      {!segmented && <div>{t.text}</div>}
      {segmented && (
        <>
          {summary !== '' && <div className={C('dshd-summary')}>{summary}</div>}
          {delta !== '' && <div className={C('dshd-delta')}>Δ {delta.split('\n')[0]}</div>}
          <button className={C('dshd-foldbtn')} onClick={() => setOpen((v) => !v)}>
            {open ? '收起详细论证 ▲' : '展开详细论证 ▼'}
          </button>
          {open && (
            <>
              {detail !== '' && <div>{detail}</div>}
              {delta !== '' && <div className={C('dshd-delta-full')}>{delta}</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}
function DebateRoot(props: { useSessions?: (s: unknown) => unknown }): React.ReactNode {
  const [open, setOpen] = useState(panelOpen)
  useEffect(() => subscribeOpen(setOpen), [])
  useEffect(() => {
    openPanel = () => setPanelOpen(true)
    return () => { if (openPanel !== null) openPanel = null }
  }, [])
  if (!open) return null
  return <DebateDialog onClose={() => setPanelOpen(false)} useSessions={props.useSessions} />
}

function InputButton(props: { useInput?: (s: unknown) => unknown; inputActions?: InputActs }): React.ReactNode {
  // 订阅草稿:有内容才亮,无内容置灰(v0.2 入口规则)。
  let draft = ''
  try {
    const input = props.useInput ? (props.useInput((s: unknown) => s) as { draft?: unknown }) : undefined
    if (typeof input?.draft === 'string') draft = input.draft
  } catch { /* store 不可用时按空处理 */ }
  const ready = draft.trim() !== ''
  const actions = props.inputActions
  return (
    <button
      type="button"
      className={C('dshd-dockbtn') + (ready ? '' : ` ${C('dshd-dockbtn-off')}`)}
      title={ready ? '以输入框内容为起点开辩' : '先在输入框写下要辩的问题'}
      disabled={!ready}
      onClick={() => {
        if (!ready) return
        // 只读不清空:内容进对话框起点展示,等点"开始辩论"建单成功后才清空输入框。
        prefillQuestion = draft.trim()
        openPanel?.()
      }}
    ><span>⚔ 辩论</span></button>
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
    { name: 'shell.overlay', id: 'debate-panel' },
    (props: never) => <DebateRoot {...(props as { useSessions?: (s: unknown) => unknown })} />,
  ))
  slots.inject('conversation.input.right', () => slots.register(
    {
      name: 'conversation.input.right',
      id: 'debate-entry',
      order: 100,
      label: () => '⚔ 双视角辩论',
      // Session scope invokes this with the current session ID. The slot's
      // renderSlot call intentionally has no owner props, so props.sessionId
      // is not populated unless we use the registration injection contract.
      inject: (sessionId) => ({ sessionId }),
    },
    (props: never) => <InputEntry {...(props as { useInput?: (s: unknown) => unknown; inputActions?: { setDraft(d: string): void }; sessionId?: unknown })} />,
  ))
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'debate', order: 31, label: () => '辩论' },
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
