import { describe, expect, it } from 'vitest'
import { roleName, roundLabel, roundSummary, stopKey, type TrFn } from '../../src/client/labels'

// 最小中文 tr:只覆盖 labels 用到的 key。
const tr: TrFn = (k, vars) => {
  const d: Record<string, string> = {
    'role.builder': '建构方', 'role.challenger': '挑战方', 'role.synthesizer': '制图员',
    'round.opening': '开题', 'round.map': '成果地图', 'round.n': '第{n}轮',
    'audit.new': '有新料', 'audit.nonew': '本轮没新料',
    'summary.agreeBoth': '双方达成一致「{answer}」',
    'summary.builderAccepts': '建构方接受了挑战方的「{answer}」',
    'summary.challengerAccepts': '挑战方接受了建构方的「{answer}」',
    'summary.standoff': '建构方坚持「{b}」,挑战方坚持「{c}」',
    'summary.opening': '开题:建构方摆出「{b}」,挑战方摆出「{c}」',
    'summary.quoted': '引用对方{q}/{t}行',
    'audit.ptr': '出处{hit}/{total}', 'audit.ptrMissing': '缺:{missing}', 'audit.ptrUnverified': '验不了{n}条',
  }
  let s = d[k] ?? k
  if (vars) for (const key in vars) s = s.split(`{${key}}`).join(String(vars[key]))
  return s
}

describe('roleName', () => {
  it('maps known roles to Chinese names', () => {
    expect(roleName('builder', tr)).toBe('建构方')
    expect(roleName('challenger', tr)).toBe('挑战方')
    expect(roleName('synthesizer', tr)).toBe('制图员')
  })

  it('passes unknown roles through instead of crashing', () => {
    // 'judge' 已移除(无生产者),回落分支用任意未知 role 覆盖。
    expect(roleName('mystery-role', tr)).toBe('mystery-role')
  })
})

describe('roundLabel', () => {
  it('labels opening and normal rounds', () => {
    expect(roundLabel(0, 'builder', tr)).toBe('开题')
    expect(roundLabel(0, 'challenger', tr)).toBe('开题')
    expect(roundLabel(2, 'builder', tr)).toBe('第2轮')
  })

  it('labels the synthesizer turn as the result map', () => {
    expect(roundLabel(3, 'synthesizer', tr)).toBe('成果地图')
  })
})

describe('roundSummary', () => {
  const base = {
    builderAnswer: '选A方案', challengerAnswer: '选B方案',
    hasNewInfo: true, quoteAudit: { quotedLines: 3, quotableLines: 5 },
  }

  it('summarizes the opening round', () => {
    expect(roundSummary({ ...base, round: 0, builderAgree: false, challengerAgree: false }, tr))
      .toBe('开题:建构方摆出「选A方案」,挑战方摆出「选B方案」;有新料 · 引用对方3/5行')
  })

  it('summarizes mutual agreement', () => {
    expect(roundSummary({ ...base, round: 2, builderAgree: true, challengerAgree: true }, tr))
      .toBe('双方达成一致「选A方案」;有新料 · 引用对方3/5行')
  })

  it('summarizes one-sided acceptance', () => {
    expect(roundSummary({ ...base, round: 2, builderAgree: true, challengerAgree: false }, tr))
      .toBe('建构方接受了挑战方的「选B方案」;有新料 · 引用对方3/5行')
    expect(roundSummary({ ...base, round: 2, builderAgree: false, challengerAgree: true }, tr))
      .toBe('挑战方接受了建构方的「选A方案」;有新料 · 引用对方3/5行')
  })

  it('summarizes a standoff with no new info and no quotes', () => {
    expect(roundSummary({
      ...base, round: 2, builderAgree: false, challengerAgree: false,
      hasNewInfo: false, quoteAudit: { quotedLines: 0, quotableLines: 0 },
    }, tr)).toBe('建构方坚持「选A方案」,挑战方坚持「选B方案」;本轮没新料')
  })

  it('summarizes pointer audit hits without gating', () => {
    expect(roundSummary({
      ...base, round: 2, builderAgree: false, challengerAgree: false,
      pointerAudit: { total: 2, hit: 1, missing: ['docs/missing.md'], unverified: [] },
    }, tr)).toBe('建构方坚持「选A方案」,挑战方坚持「选B方案」;有新料 · 引用对方3/5行 · 出处1/2 · 缺:docs/missing.md')
    expect(roundSummary({
      ...base, round: 2, builderAgree: false, challengerAgree: false,
      pointerAudit: { total: 2, hit: 1, missing: [], unverified: ['live/a.py'] },
    }, tr)).toBe('建构方坚持「选A方案」,挑战方坚持「选B方案」;有新料 · 引用对方3/5行 · 出处1/2 · 验不了1条')
    // 老局(字段缺失)/无指针 → 不显示,不猜。
    expect(roundSummary({ ...base, round: 2, builderAgree: false, challengerAgree: false }, tr))
      .toBe('建构方坚持「选A方案」,挑战方坚持「选B方案」;有新料 · 引用对方3/5行')
    expect(roundSummary({
      ...base, round: 2, builderAgree: false, challengerAgree: false,
      pointerAudit: null,
    }, tr)).toBe('建构方坚持「选A方案」,挑战方坚持「选B方案」;有新料 · 引用对方3/5行')
  })
})

describe('stopKey', () => {
  const agree = { round: 5, builderAgree: true, challengerAgree: true, builderAnswer: '选A方案', challengerAnswer: '选A方案' }
  const fight = { round: 5, builderAgree: false, challengerAgree: false, builderAnswer: '选A方案', challengerAnswer: '选B方案' }

  it('上限轮才一致 → 压线键(跟 host 的 convergedAtCap 同构)', () => {
    const rounds = [1, 2, 3, 4].map((n) => ({ ...fight, round: n })).concat([{ ...agree, round: 5 }])
    expect(stopKey('convergence', rounds, 5)).toBe('stop.convergenceCap')
  })

  it('提前一致 → 普通键(不看轮数,只看"谈完没")', () => {
    const rounds = [{ ...agree, round: 1 }, { ...agree, round: 2 }, { ...agree, round: 3 }]
    expect(stopKey('convergence', rounds, 5)).toBe('stop.convergence')
  })

  it('最后一轮但没收敛 → 跑满/饱和各走各的键,不蹭压线', () => {
    const rounds = [1, 2, 3, 4, 5].map((n) => ({ ...fight, round: n }))
    expect(stopKey('maxRounds', rounds, 5)).toBe('stop.maxRounds')
    expect(stopKey('convergence', rounds, 5)).toBe('stop.convergence')
  })

  it('没给上限就别猜:缺 maxRounds 时永远回普通键', () => {
    const rounds = [1, 2, 3, 4, 5].map((n) => ({ ...agree, round: n }))
    expect(stopKey('convergence', rounds, undefined)).toBe('stop.convergence')
    expect(stopKey('saturation', rounds, 5)).toBe('stop.saturation')
    expect(stopKey('manual', rounds, 5)).toBe('stop.manual')
  })
})
