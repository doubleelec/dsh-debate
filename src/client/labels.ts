/**
 * 辩论框人话标签(纯函数,无 React / 无 DOM,可单元测试)。
 *
 * role/轮次翻译 + 每轮一句话小结(翻译 host 的判定数据 agree/answer/hasNewInfo,
 * 不调模型)。tr 由调用方从 locale 传入,未知 role 原样显示不崩。
 */

export type TrFn = (k: string, vars?: Record<string, string | number>) => string

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
  quoteAudit: { quotedLines: number; quotableLines: number }
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
  if (r.quoteAudit.quotableLines > 0) tail.push(tr('summary.quoted', { q: r.quoteAudit.quotedLines, t: r.quoteAudit.quotableLines }))
  return `${verdict};${tail.join(' · ')}`
}
