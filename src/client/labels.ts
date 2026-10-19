/**
 * 辩论框人话标签(纯函数,无 React / 无 DOM,可单元测试)。
 *
 * role/轮次翻译 + 每轮一句话小结(翻译 host 的判定数据 agree/answer/hasNewInfo,
 * 不调模型)。tr 由调用方从 locale 传入,未知 role 原样显示不崩。
 */

export type TrFn = (k: string, vars?: Record<string, string | number>) => string

/** 面板缺失清单展示截断(与 debate.ts 的 MISSING_SHOW_MAX 系对应,面板地方小所以更短)。 */
const PANEL_MISSING_SHOW_MAX = 2

/** role 名映射:未知 role 原样显示,不崩。 */
export function roleName(role: string, tr: TrFn): string {
  if (role === 'builder') return tr('role.builder')
  if (role === 'challenger') return tr('role.challenger')
  if (role === 'synthesizer') return tr('role.synthesizer')
  return role
}

/** 轮次标签:round 0=开题,synthesizer 的 turn=成果地图,其余=第 N 轮。 */
export function roundLabel(round: number, role: string, tr: TrFn): string {
  if (role === 'synthesizer') return tr('round.map')
  if (round <= 0) return tr('round.opening')
  return tr('round.n', { n: round })
}

const shortAnswer = (s: string, len = 18): string => s.slice(0, len)

export interface RoundVerdict {
  round: number
  builderAnswer: string
  builderAgree: boolean
  challengerAnswer: string
  challengerAgree: boolean
  hasNewInfo: boolean
  /** v4 焦点账本:本轮挑战者自报的未决条件(null=没提供)。 */
  pendingItems?: string[] | null
  quoteAudit: { quotedLines: number; quotableLines: number }
  /** 出处指针审计(null=无文件型指针/老局没验,只审计不 gate)。 */
  pointerAudit?: { total: number; hit: number; missing: string[]; unverified: string[] } | null
}

/** 每轮一句话小结:翻译 host 的判定数据,不调模型。 */
export function roundSummary(r: RoundVerdict, tr: TrFn): string {
  const b = r.builderAnswer !== '' ? shortAnswer(r.builderAnswer) : '—'
  const c = r.challengerAnswer !== '' ? shortAnswer(r.challengerAnswer) : '—'
  let verdict: string
  if (r.round <= 0) {
    verdict = tr('summary.opening', { b, c })
  } else if (r.builderAgree && r.challengerAgree) {
    verdict = tr('summary.agreeBoth', { answer: r.builderAnswer !== '' ? shortAnswer(r.builderAnswer) : c })
  } else if (r.builderAgree) {
    verdict = tr('summary.builderAccepts', { answer: c })
  } else if (r.challengerAgree) {
    verdict = tr('summary.challengerAccepts', { answer: b })
  } else {
    verdict = tr('summary.standoff', { b, c })
  }
  const tail: string[] = [r.hasNewInfo ? tr('audit.new') : tr('audit.nonew')]
  // v4:未决条数是"还要谈几件事"的直接读数,列出来比一串判定标记好懂。
  const n = r.pendingItems?.length ?? 0
  if (n > 0) tail.push(tr('summary.pending', { n }))
  if (r.quoteAudit.quotableLines > 0) tail.push(tr('summary.quoted', { q: r.quoteAudit.quotedLines, t: r.quoteAudit.quotableLines }))
  // 出处指针审计:只报命中数,不 gate(缺 side 数据时不猜,直接不显示)。
  // 面板只列前 2 条缺失(地方小),全量在结论文档里——截断数见 debate.ts MISSING_SHOW_MAX 系。
  const ptr = r.pointerAudit
  if (ptr !== undefined && ptr !== null && ptr.total > 0) {
    tail.push(tr('audit.ptr', { hit: ptr.hit, total: ptr.total }))
    if (ptr.missing.length > 0) tail.push(tr('audit.ptrMissing', { missing: ptr.missing.slice(0, PANEL_MISSING_SHOW_MAX).join('、') }))
    if (ptr.unverified.length > 0) tail.push(tr('audit.ptrUnverified', { n: ptr.unverified.length }))
  }
  return `${verdict};${tail.join(' · ')}`
}

/**
 * 停机标题键:convergence 恰好撞在上限轮时,用压线键而不是提前收敛键。
 * 判据跟 host 的 convergedAtCap 同构(rounds.length===maxRounds 且最后一轮真收敛),
 * 只是这里只有面板手里的数据(rounds/maxRounds),不调模型不读 host。
 */
export function stopKey(
  stopReason: string | null,
  rounds: Array<{ round: number; builderAgree: boolean; challengerAgree: boolean; builderAnswer: string; challengerAnswer: string }>,
  maxRounds?: number,
): string {
  if (stopReason === 'convergence' && maxRounds !== undefined && maxRounds > 1 && rounds.length === maxRounds) {
    const last = rounds[rounds.length - 1]
    if (last !== undefined && last.builderAgree && last.challengerAgree
      && last.builderAnswer.trim() !== '' && last.challengerAnswer.trim() !== '') {
      return 'stop.convergenceCap'
    }
  }
  return `stop.${stopReason}`
}
