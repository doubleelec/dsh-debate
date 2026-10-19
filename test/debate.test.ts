import { describe, expect, it } from 'vitest'
import {
  containsBannedPhrase,
  isConverged,
  isSaturated,
  isOneSidedAccept,
  isTopicLoop,
  normalizeAnswer,
  buildBuilderPrompt,
  buildBuilderRoundPrompt,
  buildChallengerPrompt,
  toDebateRound,
  roundConverged,
  auditQuotes,
  QUOTABLE_MIN_LEN,
  QUOTE_FRAG_LEN,
  QUOTE_HIT_ALERT,
  STOP_PROTOCOL_VERSION,
  classifyQuestion,
  extractSessionContext,
  parseAgree,
  parseAnswer,
  detectNewInfo,
  hasNewInfoSignal,
  slimHandoff,
  parsePendingItems,
  normalizePending,
  pendingStalled,
  formatPendingFocus,
  changesOf,
  buildFallbackSummary,
  extractDecisionSummary,
  stripDecisionSummary,
  buildSynthesizerPrompt,
  DECISION_SECTION,
  PENDING_MAX_ITEMS,
  convergedAtCap,
  extractPointers,
  auditPointers,
  parseGaps,
  gapAge,
  type DebateRound,
  type TranscriptEntry,
} from '../src/debate'
import { normalizeConfig, extractModelEcho, isRouteIneffective, resolveAuto, stepOpen, stepRound, stepSynthesize, sessions, extractHandoffConclusion, heartbeatOf, epochStopReason, epochStopDetail, stepOpenResident, stepRoundResident, turnVerdict, isRetriableTurnError, recordRoundAndJudge, driveResidentTurn, createResidentPair, STEP_STALL_MS, STEP_HARD_CAP_MS } from '../src/index'
import { defaultLensIds, findLens, LENS_TEMPLATES } from '../src/lenses'
import { splitSections } from '../src/client/sections'

describe('panel sections', () => {
  it('splitSections 三段原样落位,制图员五件套走 rest', () => {
    const s = splitSections('## 结论摘要\n立场 A\n## 详细论证\n论证 B\n## 本轮变化\n变化 C')
    expect(s.summary).toBe('立场 A')
    expect(s.detail).toBe('论证 B')
    expect(s.delta).toBe('变化 C')
    expect(s.rest).toBe('')
    // 制图员输出没有三段标题:整段原样展示,不进分段。
    const m = splitSections('1. 视角清单:成本\n2. 论证表:……')
    expect(m.rest).toBe('1. 视角清单:成本\n2. 论证表:……')
    expect(m.summary).toBe('')
  })
})

describe('normalizeAnswer', () => {
  it('去空白标点且大小写不敏感', () => {
    expect(normalizeAnswer('上 K8s,能！')).toBe(normalizeAnswer('上k8s能'))
  })
  it('空串归一后仍为空', () => {
    expect(normalizeAnswer('   ')).toBe('')
  })
})

describe('isConverged', () => {
  it('双 agree + 同答案 → 收敛', () => {
    expect(isConverged(true, true, '选 A 方案。', '选A方案')).toBe(true)
  })
  it('任一方未 agree → 不收敛', () => {
    expect(isConverged(true, false, '选 A', '选 A')).toBe(false)
  })
  it('答案不同 → 不收敛', () => {
    expect(isConverged(true, true, '选 A', '选 B')).toBe(false)
  })
  it('空答案 → 不收敛', () => {
    expect(isConverged(true, true, '', '')).toBe(false)
  })
})

describe('isSaturated', () => {
  const round = (hasNewInfo: boolean): DebateRound => ({
    round: 1, builderAnswer: 'a', builderAgree: false,
    challengerAnswer: 'b', challengerAgree: false, hasNewInfo, builderRelayChars: 0,
    protoVersion: STOP_PROTOCOL_VERSION, pendingItems: null,
    quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
  })
  it('空轮次不饱和', () => {
    expect(isSaturated([])).toBe(false)
  })
  it('末轮无新信息 → 饱和', () => {
    expect(isSaturated([round(true), round(false)])).toBe(true)
  })
  it('末轮有新信息 → 不饱和', () => {
    expect(isSaturated([round(false), round(true)])).toBe(false)
  })
})

describe('containsBannedPhrase', () => {
  it('检出第五态黑话', () => {
    expect(containsBannedPhrase('总体可行,建议上')).toContain('总体可行')
  })
  it('干净文本无命中', () => {
    expect(containsBannedPhrase('已支撑:需求 §3.2 给出 5000 TPS')).toEqual([])
  })
})

describe('lenses', () => {
  it('四模板齐全且每类有默认 lens', () => {
    for (const t of ['selection', 'review', 'tradeoff', 'causal'] as const) {
      expect(LENS_TEMPLATES[t].defaultLenses.length).toBeGreaterThan(0)
      expect(defaultLensIds(t).length).toBe(LENS_TEMPLATES[t].defaultLenses.length)
    }
  })
  it('findLens 跨题型可查', () => {
    expect(findLens('metric')?.name).toBe('指标完备')
    expect(findLens('nope')).toBeUndefined()
  })
})

describe('normalizeConfig', () => {
  it('只收三模型+轮数,无问题也通过', () => {
    const r = normalizeConfig({})
    expect('config' in r).toBe(true)
    if ('config' in r) {
      expect(r.config.maxRounds).toBe(5)
      expect(r.config.auto).toBeUndefined()
    }
  })
  it('轮数钳制 1~20(上限 20:10 轮题刚好压线,超 20 未收敛多半真谈不拢)', () => {
    const r = normalizeConfig({ maxRounds: 99 })
    if ('config' in r) expect(r.config.maxRounds).toBe(20)
    const lo = normalizeConfig({ maxRounds: 0 })
    if ('config' in lo) expect(lo.config.maxRounds).toBe(1)
    const ok = normalizeConfig({ maxRounds: 20 })
    if ('config' in ok) {
      expect(ok.config.maxRounds).toBe(20)
      // 没被钳:不留痕。
      expect(ok.config.note).toBeUndefined()
    }
  })
  it('轮数被钳时留痕:静默丢配置比报错更糟', () => {
    const r = normalizeConfig({ maxRounds: 30 })
    if (!('config' in r)) throw new Error('bad')
    expect(r.config.maxRounds).toBe(20)
    expect(r.config.note).toContain('30')
    expect(r.config.note).toContain('20')
  })
  it('制图 prompt:总结语言铁律(术语展开/依据说人话/下一步可执行)', () => {
    const p = buildSynthesizerPrompt('按任务还是按仓划分?', '[R1 #1 builder] xxx')
    // 术语第一次出现必须展开,不能扔缩写。
    expect(p).toMatch(/术语.*展开|缩写|第一次出现/)
    // 依据不许只甩编号,必须一句话说清内容。
    expect(p).toMatch(/只写编号|编号.*内容|不许只/)
    // 下一步必须可执行:查什么/跑什么/找谁,缺一不可。
    expect(p).toMatch(/查什么|跑什么|找谁|可执行/)
  })
  it('兜底收尾:结论行说人话,不甩编号', () => {
    const mk = (over: Partial<DebateRound> = {}): DebateRound => ({
      round: 1, builderAnswer: 'a', builderAgree: true,
      challengerAnswer: 'a', challengerAgree: true, hasNewInfo: true, builderRelayChars: 0,
      protoVersion: STOP_PROTOCOL_VERSION, pendingItems: null,
      quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
      ...over,
    })
    const s = buildFallbackSummary('上不上 K8s?', [mk()], 'convergence', 5)
    // 停机说法展开,不只说"共识收敛"四个字。
    expect(s).toMatch(/第 1 轮|提前|收敛/)
    // 依据行不出现裸编号引用。
    expect(s).not.toMatch(/\[R\d+#\d+\]/)
  })
  it('目标工作区:透传 targetCwd,空串不进 config', () => {
    const withCwd = normalizeConfig({ maxRounds: 2, targetCwd: 'D:\\proj\\ai_proxy' })
    if (!('config' in withCwd)) throw new Error('bad')
    expect(withCwd.config.targetCwd).toBe('D:\\proj\\ai_proxy')
    const empty = normalizeConfig({ maxRounds: 2, targetCwd: '  ' })
    if (!('config' in empty)) throw new Error('bad')
    expect(empty.config.targetCwd).toBeUndefined()
    const missing = normalizeConfig({ maxRounds: 2 })
    if (!('config' in missing)) throw new Error('bad')
    expect(missing.config.targetCwd).toBeUndefined()
  })
})

describe('extractModelEcho', () => {
  it('提取 MODEL: 回显', () => {
    expect(extractModelEcho('xxx\nMODEL:local-proxy/ds4-flash-nothink\n')).toBe('local-proxy/ds4-flash-nothink')
  })
  it('无回显返回 null', () => {
    expect(extractModelEcho('没有回显')).toBeNull()
  })
  it('unknown 是没信息不是相同信息:双方都 unknown 不判路由失效', () => {
    const diff = { builder: { provider: 'local-proxy', model: 'a' }, challenger: { provider: 'local-proxy', model: 'b' } }
    expect(isRouteIneffective('unknown', 'unknown', diff.builder, diff.challenger)).toBe(false)
    expect(isRouteIneffective('UNKNOWN', 'unknown', diff.builder, diff.challenger)).toBe(false)
    expect(isRouteIneffective(null, 'x/y', diff.builder, diff.challenger)).toBe(false)
    // 双方报出具体且相同的回显、但配置不同 → 才判失效。
    expect(isRouteIneffective('local-proxy/a', 'local-proxy/a', diff.builder, diff.challenger)).toBe(true)
    expect(isRouteIneffective('local-proxy/a', 'local-proxy/b', diff.builder, diff.challenger)).toBe(false)
    // 配置相同 → 本来就是单模型双角色,不判。
    const same = { builder: { provider: 'local-proxy', model: 'a' }, challenger: { provider: 'local-proxy', model: 'a' } }
    expect(isRouteIneffective('local-proxy/a', 'local-proxy/a', same.builder, same.challenger)).toBe(false)
  })
})

describe('classifyQuestion', () => {
  it('评审信号 → review', () => {
    expect(classifyQuestion('架构设计能满足性能指标吗').questionType).toBe('review')
  })
  it('权衡信号 → tradeoff', () => {
    expect(classifyQuestion('稳定还是快,哪个优先').questionType).toBe('tradeoff')
  })
  it('因果信号 → causal', () => {
    expect(classifyQuestion('为什么这个接口这么慢').questionType).toBe('causal')
  })
  it('默认 → selection', () => {
    expect(classifyQuestion('上不上 K8s').questionType).toBe('selection')
  })
})

describe('extractSessionContext', () => {
  it('提取最近 user/assistant 文本,跳过触发语', () => {
    const events = [
      { type: 'user/message', data: { message: { content: 'Redis 压测过了,扛不住' } } },
      { type: 'user/message', data: { message: { content: '请调用 debate_run 工具执行辩论单 x' } } },
      { type: 'assistant/message', data: { message: { content: '收到' } } },
    ]
    const ctx = extractSessionContext(events)
    expect(ctx).toContain('Redis 压测过了')
    expect(ctx).not.toContain('debate_run')
  })
  it('较早的任务背景不应因最近 10 条确认消息而丢失', () => {
    const events = [
      { type: 'user/message', data: { content: '我们正在评估迁移到 PostgreSQL，重点关注回滚窗口与复制延迟。' } },
      ...Array.from({ length: 12 }, (_, i) => ({ type: i % 2 === 0 ? 'user/message' : 'assistant/message', data: { content: i % 2 === 0 ? '确认，继续。' : '收到，我继续处理。' } })),
    ]
    expect(extractSessionContext(events)).toContain('迁移到 PostgreSQL')
    expect(extractSessionContext(events)).not.toContain('收到，我继续处理')
  })
  it('读取 DSH SessionEvent 的 message.content 文本块形状', () => {
    const events = [
      { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '先前已确认迁移计划需保留 PostgreSQL 复制延迟检查。' }] } } },
      ...Array.from({ length: 12 }, (_, i) => ({ type: i % 2 === 0 ? 'user/message' : 'assistant/message', data: { message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: i % 2 === 0 ? '继续。' : '收到。' }] } } })),
    ]
    expect(extractSessionContext(events)).toContain('PostgreSQL 复制延迟检查')
  })
  it('对话中提到 debate_run 不应导致整条历史被丢弃', () => {
    const substantive = '我们前面已经确认：HTTP 硬触发负责启动，且 debate_run 仅是插件里的内部链路名，不是当前用户问题。'
    const events = [{ type: 'assistant/message', data: { content: substantive } }]
    expect(extractSessionContext(events)).toContain('HTTP 硬触发负责启动')
  })
  it('不把单独的继续确认当成背景消息', () => {
    const events = [
      { type: 'user/message', data: { content: '我们已经决定先保持 SSH 发布通道，HTTPS 作为备用。' } },
      { type: 'user/message', data: { content: '那请继续吧。' } },
    ]
    expect(extractSessionContext(events)).toContain('保持 SSH 发布通道')
    expect(extractSessionContext(events)).not.toContain('那请继续吧')
  })
  it('忽略触发噪声后仍能向前找较早的任务背景', () => {
    const events = [
      { type: 'user/message', data: { content: '我们正在评估迁移到 PostgreSQL，重点关注回滚窗口与复制延迟。' } },
      ...Array.from({ length: 12 }, (_, i) => ({ type: i % 2 === 0 ? 'user/message' : 'assistant/message', data: { content: i % 2 === 0 ? '确认，继续。' : '收到' } })),
    ]
    expect(extractSessionContext(events)).toContain('迁移到 PostgreSQL')
  })
  it('空事件返回空串', () => {
    expect(extractSessionContext([])).toBe('')
  })
})

describe('resolveAuto', () => {
  it('hint 优先当问题', () => {
    const auto = resolveAuto([], '主库延迟高怎么办')
    expect(auto?.question).toBe('主库延迟高怎么办')
    expect(auto?.questionType).toBe('causal')
  })
  it('无 hint 跳过单独确认并取最近的实质 user 消息', () => {
    const auto = resolveAuto([
      { type: 'user/message', data: { content: '架构满足指标吗' } },
      { type: 'user/message', data: { content: '那请继续吧。' } },
    ], '')
    expect(auto?.question).toBe('架构满足指标吗')
    expect(auto?.questionType).toBe('review')
  })
})

describe('session context prompts', () => {
  const lenses = [{ id: 'cost', name: '成本', description: 'd' }]
  it('背景包拼入建构者 prompt', () => {
    const p = buildBuilderPrompt('上 K8s?', lenses, 'selection', 'Redis 已验证扛不住')
    expect(p).toContain('Redis 已验证扛不住')
  })
  it('无背景时不出现背景段', () => {
    const p = buildBuilderPrompt('上 K8s?', lenses, 'selection')
    expect(p).not.toContain('背景(')
  })
  it('背景包拼入挑战者 prompt', () => {
    const p = buildChallengerPrompt('上 K8s?', '建构输出', '', 1, 5, '主库指 db-primary')
    expect(p).toContain('主库指 db-primary')
  })
})

describe('stop protocol', () => {
  it('parseAgree 只认显式接受(含全角与中文)', () => {
    expect(parseAgree('## 结论摘要\nagree=true\nanswer=上 K8s')).toBe(true)
    expect(parseAgree('agree = True')).toBe(true)
    expect(parseAgree('agree：true')).toBe(true)
    // 回归:JS 的 \b 按 ASCII 词边界算,中文"是"曾因此永远漏判。
    expect(parseAgree('agree=是')).toBe(true)
    expect(parseAgree('agree=是\nanswer=x')).toBe(true)
    expect(parseAgree('接受对方答案=true')).toBe(true)
    expect(parseAgree('接受=true')).toBe(true)
    expect(parseAgree('agree=false')).toBe(false)
    expect(parseAgree('我不同意')).toBe(false)
    expect(parseAgree('')).toBe(false)
    // 不能把 false 误当 true。
    expect(parseAgree('agree=false\nanswer=不接受')).toBe(false)
  })
  it('判定与审计共用同一份解析输入(toDebateRound)', () => {
    const rec = toDebateRound(2, 'agree=true\nanswer=上 K8s', 'agree=true\nanswer=上K8s。', '旧文本')
    expect(rec.round).toBe(2)
    expect(rec.builderAgree).toBe(true)
    expect(rec.challengerAgree).toBe(true)
    expect(roundConverged(rec)).toBe(true)
    expect(rec.hasNewInfo).toBe(true)
    expect(isSaturated([rec])).toBe(false)
    // B5:记录自带协议版本,旧局可追溯。
    expect(rec.protoVersion).toBe(STOP_PROTOCOL_VERSION)
  })
  it('B5 协议版本是单调递增的整数,改解析必先 bump', () => {
    expect(Number.isInteger(STOP_PROTOCOL_VERSION)).toBe(true)
    expect(STOP_PROTOCOL_VERSION).toBeGreaterThanOrEqual(2)
  })
  it('B6 引用审计:命中原文行才算数,标题/自报/短行不算', () => {
    const builderOut = [
      '## 结论摘要',
      '主张一:缓存扛不住峰值,需要上 K8s 做自动扩缩。',
      '主张二:成本可接受,按量付费即可。',
      '短',
      'agree=false',
      'answer=上 K8s',
    ].join('\n')
    const challengerOut = '复述:对方说"主张一:缓存扛不住峰值,需要上 K8s 做自动扩缩。"我反对,因为……'
    const a = auditQuotes(builderOut, challengerOut)
    expect(a.quotableLines).toBe(2)
    expect(a.quotedLines).toBe(1)
    expect(a.hitLines).toEqual([2])
    expect(a.hitRate).toBeCloseTo(0.5)
    // 零引用:不算 0 分,算 null(无可引用行与引用 0 行是两回事)。
    expect(auditQuotes('', '随便写').hitRate).toBeNull()
    expect(auditQuotes('短\nagree=false', '随便写').hitRate).toBeNull()
    // 阈值本身可测:12 字实质句 / 12 字片段 / 0.3 告警线。
    expect(QUOTABLE_MIN_LEN).toBe(12)
    expect(QUOTE_FRAG_LEN).toBe(12)
    expect(QUOTE_HIT_ALERT).toBe(0.3)
  })
  it('B6 片段级:转述式引用(只抄短语)也算命中,纯改写不算', () => {
    const builderOut = '立场修正:共识路径从可信降为可回放不可担保,饱和按信号词在场短路易跑满且无成本闸。'
    // 只抄了"无成本闸成立"式短语 → 命中。
    const hit = auditQuotes(builderOut, 'R2 原文:"无成本闸成立"并列出单步6分钟。我反对。')
    // "无成本闸"只有 4 字 < 12 字片段 → 不命中;换一段长的抄。
    expect(hit.quotedLines).toBe(0)
    const hit2 = auditQuotes(builderOut, '对方说"饱和按信号词在场短路易跑满",这不对。')
    expect(hit2.quotedLines).toBe(1)
    // 纯改写一个字不抄 → 不命中(下限估计,见 ADR-0016)。
    expect(auditQuotes(builderOut, '我觉得你的成本论证有问题。').quotedLines).toBe(0)
  })
  it('饱和判定走 isSaturated(主循环与协议层同源,不再有死代码)', () => {
    const r: DebateRound = { round: 1, builderAnswer: 'a', builderAgree: false, challengerAnswer: 'b', challengerAgree: false, hasNewInfo: false, builderRelayChars: 0, protoVersion: STOP_PROTOCOL_VERSION, pendingItems: null, quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null } }
    expect(isSaturated([r])).toBe(true)
    expect(isSaturated([])).toBe(false)
  })
  it('B1 否定关:否定句不算新增,肯定句才算', () => {
    expect(hasNewInfoSignal('本轮没有新增缺口')).toBe(false)
    expect(hasNewInfoSignal('无新增信息,立场未变')).toBe(false)
    expect(hasNewInfoSignal('未发现新缺口')).toBe(false)
    expect(hasNewInfoSignal('本轮新增缺口:缺压测数据')).toBe(true)
    expect(hasNewInfoSignal('让步:收回 C5')).toBe(true)
    expect(hasNewInfoSignal('立场不变,论证照旧')).toBe(false)
    // 回归:否定只在本行生效,不被上一行污染。
    expect(hasNewInfoSignal('没有新增观点\n本轮补充:压测数据缺口')).toBe(true)
    // 端到端:否定句不应误判为有新增 → 该饱和就饱和。
    expect(detectNewInfo('甲:立场 A', '甲:立场 A。本轮没有新增缺口,也没有让步。')).toBe(false)
  })
  it('B4 交棒瘦身:只保结论摘要 + 本轮变化,详细论证按预算截断', () => {
    const full = [
      '## 结论摘要',
      '应上 K8s。',
      '## 详细论证',
      '细节'.repeat(3000),
      '## 本轮变化',
      '新增:压测口径。',
      'agree=true',
      'answer=应上 K8s',
    ].join('\n')
    const b = slimHandoff(full, 800)
    expect(b.fullChars).toBe(full.length)
    expect(b.briefChars).toBeLessThanOrEqual(880)
    expect(b.truncated).toBe(true)
    expect(b.text).toContain('## 结论摘要')
    expect(b.text).toContain('## 本轮变化')
    expect(b.text).toContain('[对方自报] agree=true answer=应上 K8s')
    expect(b.text).toContain('已略')
    // 短文本不截断。
    const short = slimHandoff('## 结论摘要\n短\n## 详细论证\n也短\n## 本轮变化\n无')
    expect(short.truncated).toBe(false)
    expect(short.briefChars).toBeLessThan(short.fullChars + 40)
  })
  it('parseAnswer 取 answer= 行,缺失回落结论摘要', () => {
    expect(parseAnswer('agree=true\nanswer=上 K8s 稳妥')).toBe('上 K8s 稳妥')
    expect(parseAnswer('answer：上 K8s')).toBe('上 K8s')
    expect(parseAnswer('## 结论摘要\n上 K8s 稳妥\n## 详细论证')).toContain('上 K8s')
    expect(parseAnswer('')).toBe('')
  })
  it('detectNewInfo:相同文本无新增,缺口信号算新增', () => {
    expect(detectNewInfo('上 K8s 稳妥', '上 K8s 稳妥')).toBe(false)
    expect(detectNewInfo('上 K8s 稳妥', '上 K8s 稳妥,新增缺口:缺压测数据')).toBe(true)
    expect(detectNewInfo('', '首轮')).toBe(true)
  })
  it('共识需双 agree + 归一化一致', () => {
    expect(isConverged(true, true, '选 A 方案。', '选A方案')).toBe(true)
    expect(isConverged(true, true, '选 A', '选 B')).toBe(false)
  })
  it('prompt 不含可被照抄的内嵌括注,且带上轮次与停机信号', () => {
    const open = buildBuilderPrompt('上 K8s?', [{ id: 'cost', name: '成本', description: 'd' }], 'selection')
    expect(open).toContain('agree=false')
    expect(open).not.toContain('(相对上一轮')
    const round = buildBuilderRoundPrompt('上 K8s?', '挑战者原文', 2, 5)
    expect(round).toContain('第 2/5 轮')
    expect(round).toContain('agree=true/false')
    expect(round).toContain('挑战者原文')
    expect(round).not.toContain('(相对上一轮')
    const ch = buildChallengerPrompt('上 K8s?', '建构原文', '', 2, 5)
    expect(ch).toContain('agree=true/false')
    expect(ch).not.toContain('(相对上一轮')
  })
})

describe('stepwise loop', () => {
  const fakeSubagents = (texts: string[]) => {
    let i = 0
    return {
      start: async () => ({
        result: Promise.resolve({ output: [{ type: 'text', text: texts[i++] ?? 'x' }], stopReason: 'completed' }),
        dispose: async () => {},
      }),
    }
  }
  const parent = { session: { id: 's' } } as never
  const signal = new AbortController().signal
  const makeSession = () => {
    const r = normalizeConfig({ maxRounds: 2 })
    if (!('config' in r)) throw new Error('bad config')
    r.config.auto = resolveAuto([{ type: 'user/message', data: { content: '上 K8s?' } }], '')
    return {
      id: 't', config: r.config, status: 'running' as const, round: -1,
      transcript: [] as TranscriptEntry[], map: null, mapText: null, error: null, mirrorToChat: false,
      progress: '', mirrorCount: 0, mirrorError: null, parentSid: null, stopReason: null, rounds: [] as DebateRound[],
      mode: 'oneShot' as const, residentError: null, streaming: {}, decisionSummary: null,
      reportRel: null, persistError: null, reportError: null, restored: false,
      createdAt: 0, updatedAt: 0,
    }
  }
  it('开题→两轮→制图依次推进,round 递增', async () => {
    const s = makeSession()
    // 链路测试不碰防呆:双方回显不同(DEFAULT builder spark vs challenger flash,见 B7)。
    await stepOpen(fakeSubagents(['MODEL:local-proxy/a', 'MODEL:local-proxy/b']) as never, parent, s, signal)
    expect(s.round).toBe(0)
    expect(s.transcript.length).toBe(2)
    await stepRound(fakeSubagents(['b1', 'c1']) as never, parent, s, signal)
    expect(s.round).toBe(1)
    await stepRound(fakeSubagents(['b2', 'c2']) as never, parent, s, signal)
    expect(s.round).toBe(2)
    await expect(stepRound(fakeSubagents(['b3', 'c3']) as never, parent, s, signal)).rejects.toThrow('rounds-exhausted')
    const { mapText } = await stepSynthesize(fakeSubagents(['map']) as never, parent, s, signal)
    expect(mapText).toBe('map')
    expect(s.mapText).toBe('map')
    expect(sessions).toBeDefined()
  })
  it('配置不同模型但回显一致 → 防呆停机', async () => {
    const s = makeSession()
    s.config.challenger = { provider: 'local-proxy', model: 'other' }
    await expect(stepOpen(fakeSubagents(['MODEL:local-proxy/a', 'MODEL:local-proxy/a']) as never, parent, s, signal)).rejects.toThrow('model-route-ineffective')
  })
})

describe('resident relay', () => {
  const signal = new AbortController().signal
  const makeSession = () => {
    const r = normalizeConfig({ maxRounds: 2 })
    if (!('config' in r)) throw new Error('bad config')
    r.config.auto = resolveAuto([{ type: 'user/message', data: { content: '上 K8s?' } }], '')
    return {
      id: 't', config: r.config, status: 'running' as const, round: -1,
      transcript: [] as TranscriptEntry[], map: null, mapText: null, error: null, mirrorToChat: false,
      progress: '', mirrorCount: 0, mirrorError: null, parentSid: null, stopReason: null, rounds: [] as DebateRound[],
      mode: 'oneShot' as const, residentError: null, streaming: {}, decisionSummary: null,
      reportRel: null, persistError: null, reportError: null, restored: false,
      createdAt: 0, updatedAt: 0,
    }
  }
  const ev = (type: string, data: unknown) => ({ type, data })
  it('常驻轮次判定:干活久不算卡死,无事件才卡死,硬顶兜底', () => {
    // 一直有进度:即便跑了 18 分钟也不算卡(干活久不是错)。
    expect(turnVerdict(0, 18 * 60 * 1000)).toBe('ok')
    // 4 分钟没有任何新事件 = 卡死。
    expect(turnVerdict(STEP_STALL_MS, 5 * 60 * 1000)).toBe('stalled')
    // 有进度也超 20 分钟 = 硬顶(永不 hang)。
    expect(turnVerdict(0, STEP_HARD_CAP_MS)).toBe('hard-cap')
    // 硬顶优先于卡死判定。
    expect(turnVerdict(STEP_STALL_MS, STEP_HARD_CAP_MS)).toBe('hard-cap')
  })
  it('判定同源:recordRoundAndJudge 记 rounds 并给出停机结论(工具分步与直驱共用)', () => {
    const s = makeSession()
    s.transcript.push({ seq: 1, role: 'builder', round: 0, text: '开题立场 A' })
    s.transcript.push({ seq: 2, role: 'challenger', round: 0, text: '开题挑战 B' })
    const v = recordRoundAndJudge(s, 1, 'agree=true\nanswer=上 K8s', 'agree=true\nanswer=上K8s。', 800)
    expect(v).toBe('convergence')
    expect(s.rounds.length).toBe(1)
    expect(s.rounds[0].builderRelayChars).toBe(800)
    expect(s.rounds[0].builderAgree).toBe(true)
  })
  it('判定同源:显式无新增 → 饱和(不再跑满)', () => {
    const s = makeSession()
    s.transcript.push({ seq: 1, role: 'builder', round: 0, text: '立场 A' })
    s.transcript.push({ seq: 2, role: 'challenger', round: 0, text: '立场 B' })
    const v = recordRoundAndJudge(
      s, 1,
      'agree=false\nanswer=A\n本轮没有新增缺口,也没有让步',
      'agree=false\nanswer=B\n本轮没有新增观点',
      400,
    )
    expect(v).toBe('saturation')
    expect(s.rounds[0].hasNewInfo).toBe(false)
  })
  it('重投判据:只重投 provider error,超时/卡死/空输出/拒绝不重投', () => {
    expect(isRetriableTurnError('resident-builder:error(Internal error: boom)')).toBe(true)
    expect(isRetriableTurnError('resident-challenger:error')).toBe(true)
    expect(isRetriableTurnError('resident-builder:stalled(4min 无新事件,已中止)')).toBe(false)
    expect(isRetriableTurnError('resident-builder:timeout(20min 硬顶,已中止)')).toBe(false)
    expect(isRetriableTurnError('resident-builder:empty-output')).toBe(false)
    expect(isRetriableTurnError('aborted')).toBe(false)
  })
  it('停止原因细节:error 取 provider 真因,不吞成 error', () => {
    const ev = (type: string, data: unknown) => ({ type, data })
    expect(epochStopDetail([ev('turn/end', { reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE' } } })])).toBe('rate limited')
    expect(epochStopDetail([ev('turn/end', { reason: { kind: 'error', error: 'boom' } })])).toBe('boom')
    expect(epochStopDetail([ev('turn/end', { reason: { kind: 'completed' } })])).toBe('')
    expect(epochStopDetail([])).toBe('')
  })
  it('交棒结论取最后非空助手消息,流式只作回落', () => {
    const events = [
      ev('assistant/message', { message: { content: [{ type: 'text', text: '第一段' }] }, stream: [] }),
      ev('assistant/message', { message: { content: [{ type: 'text', text: '第二段·终稿' }] }, stream: [] }),
    ]
    expect(extractHandoffConclusion(events as never)).toBe('第二段·终稿')
    const streamed = [ev('assistant/attempt', { stream: [{ type: 'text-chunks', texts: ['流式回落'] }] })]
    expect(extractHandoffConclusion(streamed as never)).toBe('流式回落')
    expect(extractHandoffConclusion([])).toBeNull()
  })
  it('epoch 终端原因映射到 seam 词汇', () => {
    expect(epochStopReason([ev('turn/end', { reason: { kind: 'completed' } })] as never)).toBe('completed')
    expect(epochStopReason([ev('turn/end', { reason: { kind: 'blocked' } })] as never)).toBe('refusal')
    expect(epochStopReason([ev('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })] as never)).toBe('aborted')
    expect(epochStopReason([])).toBe('error')
  })
  const fakeResident = (texts: string[]) => {
    let log: { type: string; data?: unknown }[] = []
    let i = 0
    const agent = {
      session: {
        id: 'resident',
        snapshotEvents: () => [...log],
      },
      followup: () => {
        const text = texts[i++] ?? 'x'
        log = [
          ...log,
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, stream: [] } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ]
      },
      whenIdle: async () => {},
      cancel: () => {},
    }
    return agent
  }
  it('实时流:onStream 收到 turn 内流式累计,结论落盘后调用方可清', async () => {
    // attempt 事件必须在 followup 之后才进来(boundary 之后),与真实现同形;预埋在 boundary 前会被切掉。
    const log: { type: string; data?: unknown }[] = [{ type: 'turn/start', data: { turn: 7 } }]
    const agent = {
      session: { id: 'r', snapshotEvents: () => [...log] },
      followup: () => {
        log.push({ type: 'assistant/attempt', data: { stream: [{ type: 'text-chunks', texts: ['正在写…'] }] } })
      },
      // turn 跑 60ms:轮询 tick(5ms)能跑到,终稿在 idle 前才落。
      whenIdle: () => new Promise<void>((res) => { setTimeout(() => {
        log.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '终稿' }] }, stream: [] } })
        log.push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
        res()
      }, 60) }),
      cancel: () => {},
    } as never
    const seen: Array<{ kind: string; text: string }> = []
    const out = await driveResidentTurn(agent, 'prompt', 'builder', new AbortController().signal, (p) => { seen.push({ kind: p.kind, text: p.text }) }, { pollMs: 5 })
    expect(out).toBe('终稿')
    // 等待期间至少发布过一次流式预览(含 attempt 增量),与最终结论同源。
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.some((p) => p.kind === 'text' && p.text.includes('正在写'))).toBe(true)
  })
  it('工具心跳:文本没出来时报 tool 事件,不碰 data 形状', async () => {
    const ev = (type: string) => ({ type, data: { whatever: { nested: [1, 2, 3] } } })
    // 后缀全是 tool 事件 → 心跳取最后一种。
    expect(heartbeatOf([ev('tool/call'), ev('tool/result'), ev('tool/call'), ev('tool/call')])).toBe('🔧 tool/call ×2')
    // 大小写不敏感,不同 tool 类型切换重计。
    expect(heartbeatOf([ev('TOOL/Call'), ev('turn/end')])).toBe('🔧 TOOL/Call ×1')
    // 无 tool 事件 → null(调用方定显示"思考中"还是空)。
    expect(heartbeatOf([ev('turn/start'), ev('assistant/message')])).toBeNull()
    expect(heartbeatOf([])).toBeNull()
  })
  it('开题→一轮交棒链不断,transcript 结构与 one-shot 同形', async () => {
    const s = makeSession()
    const pair = { builder: fakeResident(['MODEL:local-proxy/a', 'b1']), challenger: fakeResident(['MODEL:local-proxy/b', 'c1']), dispose: async () => {} } as never
    await stepOpenResident(pair, s, signal)
    expect(s.round).toBe(0)
    expect(s.transcript.length).toBe(2)
    const { round } = await stepRoundResident(pair, s, signal)
    expect(round).toBe(1)
    expect(s.transcript.length).toBe(4)
    expect(s.transcript.map((e: { role: string }) => e.role)).toEqual(['builder', 'challenger', 'builder', 'challenger'])
  })
  it('常驻建对:子会话带 subagent 血统(侧边栏隐藏,不堆未分组)', async () => {
    const created: Array<{ sessionId: string; meta?: Record<string, unknown> }> = []
    const fakeAgents = {
      get: () => undefined,
      list: () => [],
      create: async (options: { sessionId: string; meta?: Record<string, unknown> }) => {
        created.push({ sessionId: options.sessionId, meta: options.meta })
        return {
          agent: {
            session: { id: options.sessionId, snapshotEvents: () => [] },
            followup: () => {},
            whenIdle: async () => {},
          },
          dispose: async () => {},
        }
      },
    }
    const parent = { session: { id: 'parent-1', snapshotEvents: () => [] } }
    const pair = await createResidentPair(
      { get: () => undefined } as never,
      fakeAgents as never,
      parent as never,
      'debate-x',
      { provider: 'p', model: 'b' },
      { provider: 'p', model: 'c' },
      new AbortController().signal,
      '/tmp/ws',
    )
    await pair.dispose()
    expect(created.map((c) => c.sessionId)).toEqual(['debate-debate-x-builder', 'debate-debate-x-challenger'])
    for (const c of created) {
      // 子会话血统:origin=subagent 让侧边栏隐藏(parent 目录见 subagentCatalog,不进未分组);
      // isSeeded=false 保证互盲(不继承 parent 历史)。
      expect(c.meta?.origin).toBe('subagent')
      expect(c.meta?.parentSession).toBe('parent-1')
      expect(c.meta?.isSeeded).toBe(false)
      expect(typeof c.meta?.delegationDepth).toBe('number')
    }
  })
  it('常驻一方挂了独立结算,错误带双方状态', async () => {
    const s = makeSession()
    const bad = {
      session: { id: 'bad', snapshotEvents: () => [] },
      followup: () => { throw new Error('resident-builder:refusal') },
      whenIdle: async () => {},
      cancel: () => {},
    }
    const pair = { builder: bad, challenger: fakeResident(['MODEL:local-proxy/a']), dispose: async () => {} } as never
    await expect(stepOpenResident(pair, s, signal)).rejects.toThrow('open-failed: builder=')
  })
})

// v4 焦点账本 + 收敛/停滞判据 + 收尾陈述(实测 2026-10 跑局:10 轮全 hasNewInfo=true,饱和成死代码)
describe('v4 pending ledger', () => {
  const mkRound = (over: Partial<DebateRound> = {}): DebateRound => ({
    round: 1, builderAnswer: 'a', builderAgree: false,
    challengerAnswer: 'b', challengerAgree: false, hasNewInfo: true, builderRelayChars: 0,
    protoVersion: STOP_PROTOCOL_VERSION, pendingItems: null,
    quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
    ...over,
  })

  it('parsePendingItems:分号/顿号/竖线都分隔,编号前缀剥掉', () => {
    expect(parsePendingItems('待决清单=载体需补第四类;C_new 阈值不得借用旧口径'))
      .toEqual(['载体需补第四类', 'C_new 阈值不得借用旧口径'])
    expect(parsePendingItems('待决清单: 1) 甲、2) 乙')).toEqual(['甲', '乙'])
    expect(parsePendingItems('待决清单=甲|乙')).toEqual(['甲', '乙'])
  })

  it('parsePendingItems:清零与未提供必须区分', () => {
    // 明确清零 → [](可以收敛)
    expect(parsePendingItems('待决清单=无')).toEqual([])
    expect(parsePendingItems('待决清单=0')).toEqual([])
    expect(parsePendingItems('待决清单=')).toEqual([])
    // 没这一行 → null(回落旧行为,不能当成"谈完了")
    expect(parsePendingItems('agree=false\nanswer=上 K8s')).toBeNull()
  })

  it('parsePendingItems:条数与单条长度都封顶', () => {
    const many = Array.from({ length: 20 }, (_, i) => `条件${i}`).join(';')
    expect(parsePendingItems(`待决清单=${many}`)?.length).toBe(PENDING_MAX_ITEMS)
    const long = parsePendingItems(`待决清单=${'长'.repeat(200)}`)
    expect(long?.[0].length).toBe(60)
  })

  it('parsePendingItems:超长截断不断词——回退到 60 字内最后一个空白/标点', () => {
    // 中文:逗号在 50 处,硬切 60 会劈开后半句,应回退到逗号前。
    const zh = `${'字'.repeat(50)}，${'字'.repeat(50)}`
    const rzh = parsePendingItems(`待决清单=${zh}`)
    expect(rzh?.[0].length).toBe(50)
    expect(rzh?.[0]).toBe('字'.repeat(50))
    // ASCII:空格分隔的词,截断后不能留半个词也不能留尾空格。
    const en = `${'word '.repeat(30)}tail`
    const ren = parsePendingItems(`待决清单=${en}`)
    expect(ren?.[0].length).toBeLessThan(60)
    expect(ren?.[0].endsWith('word')).toBe(true)
    // 无边界可退(如纯单字重复) → 仍硬切 60(老行为不变)。
    const hard = parsePendingItems(`待决清单=${'长'.repeat(200)}`)
    expect(hard?.[0].length).toBe(60)
    // 60 字内不断:短条原样。
    expect(parsePendingItems('待决清单=短条件')).toEqual(['短条件'])
  })

  it('pendingStalled:连续两轮清单逐条相同才算停滞(顺序无关)', () => {
    const a = mkRound({ round: 1, pendingItems: ['载体需补第四类', 'C_new 阈值'] })
    const b = mkRound({ round: 2, pendingItems: ['C_new 阈值', '载体需补第四类'] })
    expect(pendingStalled([a, b])).toBe(true)
    // 清单变了 → 还在推进,不停
    expect(pendingStalled([a, mkRound({ round: 2, pendingItems: ['只有一条'] })])).toBe(false)
    // 清零 → 不算停滞(该走收敛判定)
    expect(pendingStalled([a, mkRound({ round: 2, pendingItems: [] })])).toBe(false)
    // 没提供 → 不算停滞(没有账本不能当作谈不动)
    expect(pendingStalled([a, mkRound({ round: 2, pendingItems: null })])).toBe(false)
    expect(pendingStalled([a])).toBe(false)
  })

  it('isSaturated 收纳焦点停滞(不再只靠信号词)', () => {
    const frozen = ['甲条件', '乙条件']
    const r1 = mkRound({ round: 1, hasNewInfo: true, pendingItems: frozen })
    const r2 = mkRound({ round: 2, hasNewInfo: true, pendingItems: frozen })
    expect(isSaturated([r1, r2])).toBe(true)
    // 清单在收敛 → 不饱和
    expect(isSaturated([r1, mkRound({ round: 2, hasNewInfo: true, pendingItems: ['只剩甲条件'] })])).toBe(false)
  })

  it('normalizePending 忽略空白标点与排序', () => {
    expect(normalizePending(['C_new 阈值', ' 载体 需补 '])).toEqual(normalizePending(['载体需补', 'C_new阈值']))
  })

  it('formatPendingFocus:空清单不加约束,非空给编号与只谈清单的规则', () => {
    expect(formatPendingFocus([])).toBe('')
    const f = formatPendingFocus(['甲', '乙'])
    expect(f).toContain('1. 甲')
    expect(f).toContain('2. 乙')
    expect(f).toContain('只处理清单内条目')
    expect(f).toContain('不得重开清单外已结事项')
  })

  it('formatPendingFocus:已接受的判据定义进焦点块,换尺重算即违规', () => {
    // 线上实测:R16 定死"横连贯=结构尺",R19 建构者换时间尺重算,同一格子四轮换三种含义。
    // 已接受的定义必须原样带进下一轮 prompt,挑战者只能挑战"尺子本身错了"(给反例),不能悄悄换尺子。
    const f = formatPendingFocus(['横连贯按结构尺算'], ['横连贯=跨会话可读同一意图验收且具权威源'])
    expect(f).toContain('已接受判据')
    expect(f).toContain('横连贯=跨会话可读同一意图验收且具权威源')
    expect(f).toMatch(/换尺.*重算|违反/)
    // 没给定判据 → 老行为,不硬编。
    expect(formatPendingFocus(['甲'])).not.toContain('已接受判据')
    // 空清单不断锁:收尾轮清单空了,判据还在,照样锁。
    const locked = formatPendingFocus([], ['横连贯=结构尺'])
    expect(locked).toContain('已接受判据')
    expect(locked).not.toContain('待决清单')
    // 双空 → 老行为,不硬编。
    expect(formatPendingFocus([])).toBe('')
  })

  it('议题循环停机:清单长期不空且答案长期不动,提前收尾', () => {
    // 线上实测:R15-R20 清单始终 1~2 条(且在变,不是停滞)、答案面不动,全在"横连贯"一格里打转,值得停。
    // 纯字面判据,不做语义判断:同一格子的四种说法首词全不一样,首词重合不可靠。
    const topic = (round: number, pending: string[]): DebateRound => mkRound({ round, hasNewInfo: true, pendingItems: pending, builderAnswer: 'F-s/F-w 等效', challengerAnswer: 'F-s/F-w 等效' })
    const rounds = [
      topic(1, ['补横连贯的单一定义并据此重算']),
      topic(2, ['补权威意图源的可操作检验']),
      topic(3, ['补锁的成本入分']),
      topic(4, ['补成本与横连贯分列']),
    ]
    expect(isTopicLoop(rounds)).toBe(true)
    // 静止清单是停滞不是循环 → 不判(归 pendingStalled 管,调用方 isSaturated 里先查停滞)。
    expect(isTopicLoop([
      topic(1, ['同清单']),
      topic(2, ['同清单']),
      topic(3, ['同清单']),
      topic(4, ['同清单']),
    ])).toBe(false)
    // 答案在变 → 还在推进,不停。
    expect(isTopicLoop([
      ...rounds.slice(0, 3),
      mkRound({ round: 4, hasNewInfo: true, pendingItems: ['补成本与横连贯分列'], builderAnswer: '新答案', challengerAnswer: '新答案' }),
    ])).toBe(false)
    // 清单空了 → 快收敛了,不算绕圈。
    expect(isTopicLoop([
      topic(1, ['补甲']),
      topic(2, ['补乙']),
      topic(3, ['补丙']),
      mkRound({ round: 4, hasNewInfo: true, pendingItems: [], builderAnswer: 'F-s/F-w 等效', challengerAnswer: 'F-s/F-w 等效' }),
    ])).toBe(false)
    // 轮数不够 → 不判。
    expect(isTopicLoop([topic(1, ['补甲'] as string[])])).toBe(false)
  })

  it('isSaturated 收纳议题循环(清单在变但在绕圈)', () => {
    const topic = (round: number, pending: string[]): DebateRound => mkRound({ round, hasNewInfo: true, pendingItems: pending, builderAnswer: '同答案', challengerAnswer: '同答案' })
    const rounds = [
      topic(1, ['补甲']),
      topic(2, ['补乙']),
      topic(3, ['补丙']),
      topic(4, ['补丁']),
    ]
    expect(isSaturated(rounds)).toBe(true)
  })

  it('跑满细分:一方已接受则结论可用,不说"谈崩"', () => {
    // 线上实测:R20 建构者 agree=true、挑战者只剩记账分歧,F-s/F-w 等效已接受,结论可用。
    const mk = (over: Partial<DebateRound> = {}): DebateRound => ({
      round: 20, builderAnswer: 'a', builderAgree: true,
      challengerAnswer: 'a', challengerAgree: false, hasNewInfo: true, builderRelayChars: 0,
      protoVersion: STOP_PROTOCOL_VERSION, pendingItems: ['补成本与横连贯分列'],
      quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
      ...over,
    })
    const s = buildFallbackSummary('哪种架构适合并行?', [mk()], 'maxRounds', 20)
    expect(s).toMatch(/一方接受|基本可用|结论.*可用|记账/)
    expect(s).not.toMatch(/谈崩|未形成明确答案/)
    // "基本可用"后不再跟"双方最终答案不一致"(归一化一致,跟一句不一致自相矛盾)。
    expect(s).not.toMatch(/双方最终答案不一致/)
    // 谁接受写谁的原文:仅挑战者接受且原文不同时,不写建构方的。
    const cOnly = buildFallbackSummary('问?', [mk({ builderAnswer: '甲 方案 A', builderAgree: false, challengerAnswer: '甲方案A', challengerAgree: true })], 'maxRounds', 20)
    expect(cOnly).toContain('挑战方已接受')
    expect(cOnly).toContain('甲方案A')
    expect(cOnly).not.toContain('甲 方案 A')
  })

  it('isOneSidedAccept:与兜底/进度同源,双agree不算单方', () => {
    const mk = (over: Partial<DebateRound> = {}): DebateRound => ({
      round: 1, builderAnswer: 'a', builderAgree: true,
      challengerAnswer: 'a', challengerAgree: false, hasNewInfo: true, builderRelayChars: 0,
      protoVersion: STOP_PROTOCOL_VERSION, pendingItems: ['x'],
      quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
      ...over,
    })
    expect(isOneSidedAccept([mk()], 'maxRounds')).toBe(true)
    // 双 agree 是 converged,不是单方接受。
    expect(isOneSidedAccept([mk({ challengerAgree: true })], 'maxRounds')).toBe(false)
    // 答案不一致 → 谈崩,不是记账分歧。
    expect(isOneSidedAccept([mk({ challengerAnswer: 'b', challengerAgree: false })], 'maxRounds')).toBe(false)
    // 非跑满 → 不判。
    expect(isOneSidedAccept([mk()], 'saturation')).toBe(false)
  })

  it('changesOf:只取「本轮变化」段,整篇信号词不再污染判定', () => {
    const text = '## 结论摘要\n这里提到缺口和补充\n## 详细论证\n又一处新增\n## 本轮变化\n无'
    expect(changesOf(text)).toBe('无')
    // 端到端:正文满篇"缺口/补充",但变化段写"无" → 判定无新增(旧口径会永远 true)
    const long = `## 结论摘要\n结论\n## 详细论证\n${'缺口与补充和新增。'.repeat(200)}\n## 本轮变化\n无\nagree=false\nanswer=x`
    const rec = toDebateRound(2, long, long, long)
    expect(rec.hasNewInfo).toBe(false)
  })

  it('toDebateRound 带上挑战者未决清单', () => {
    const rec = toDebateRound(2, 'agree=false\nanswer=甲', 'agree=false\nanswer=乙\n待决清单=丙;丁', '旧')
    expect(rec.pendingItems).toEqual(['丙', '丁'])
    expect(rec.protoVersion).toBe(STOP_PROTOCOL_VERSION)
  })

  it('toDebateRound:给了 exists 就验指针,不给就记 null(不验不猜)', () => {
    const b = 'agree=false\nanswer=甲\n见 `live/run_live.py:162`。'
    const c = 'agree=false\nanswer=乙\n另见 `docs/missing.md`。'
    const withFn = toDebateRound(1, b, c, '旧', 0, (p) => p === 'live/run_live.py')
    expect(withFn.pointerAudit?.total).toBe(2)
    expect(withFn.pointerAudit?.hit).toBe(1)
    expect(withFn.pointerAudit?.missing).toEqual(['docs/missing.md'])
    const withoutFn = toDebateRound(1, b, c, '旧')
    expect(withoutFn.pointerAudit).toBeNull()
  })

  it('extractPointers:只抽文件型指针,行号/行尾标点剥掉,节引用不抽', () => {
    const text = [
      'Evt5 由 `live/run_live.py:162-172` 触发,见 `docs/spec.md §Solution`。',
      '[事实,docs/architecture.toml] 托管产物须申报;',
      '[事实,spec §Solution] 快照只读副本;',
      'tickets/02:8 与其 :14 仍写"上月+当月",`archive/YYYY-MM.zip` 的触发点要改。',
      '裸词 run_live.py 不算(无路径,无法定位)。',
    ].join('\n')
    const ps = extractPointers(text)
    // live/run_live.py(含行号剥掉) / docs/spec.md / docs/architecture.toml / tickets/02 / archive/YYYY-MM.zip
    expect(ps).toContain('live/run_live.py')
    expect(ps).toContain('docs/spec.md')
    expect(ps).toContain('docs/architecture.toml')
    expect(ps).toContain('tickets/02')
    expect(ps).toContain('archive/YYYY-MM.zip')
    // spec §Solution 这种节引用无法定位 → 不抽,不算缺失。
    expect(ps.every((p) => !p.startsWith('spec '))).toBe(true)
    expect(ps.some((p) => p.includes(':'))).toBe(false)
    // 去重。
    expect(ps.length).toBe(new Set(ps).size)
  })

  it('auditPointers:存在性只审计不 gate,无指针返回 null', () => {
    // 命中/缺失二分(节引用根本不进抽取)。
    const a = auditPointers('见 `live/run_live.py:162` 与 `docs/missing.md`,另 [事实,spec §Solution] 快照只读。', (p) => p === 'live/run_live.py')
    expect(a?.total).toBe(2)
    expect(a?.hit).toBe(1)
    expect(a?.missing).toEqual(['docs/missing.md'])
    expect(a?.unverified).toEqual([])
    expect(a?.hitRate).toBe(0.5)
    // exists 抛错 = 验不了,进 unverified(验不了 ≠ 不存在,不进 missing)。
    const u = auditPointers('见 `live/a.py`。', () => { throw new Error('no-fs') })
    expect(u?.missing).toEqual([])
    expect(u?.unverified).toEqual(['live/a.py'])
    expect(u?.hitRate).toBe(0)
    // 无文件型指针 → null(与"引用 0 行"区分开,跟 quoteAudit.hitRate=null 同一哲学)。
    expect(auditPointers('没有指针,只有 [事实,spec §Solution] 节引用。', () => true)).toBeNull()
    expect(auditPointers('', () => true)).toBeNull()
  })

  it('extractPointers:纯文本裸路径与前导点路径也抽,行尾标点剥掉', () => {
    const ps = extractPointers('详见 docs/foo.md,另有 .data_live/snap.json 未采样;相对 ./x/y.txt 可读。')
    expect(ps).toContain('docs/foo.md')
    expect(ps).toContain('.data_live/snap.json')
    expect(ps).toContain('./x/y.txt')
    // "a/b"这种无扩展名的措辞不当路径。
    expect(extractPointers('甲乙 a/b 丙丁')).toEqual([])
  })

  it('parseGaps:只认缺口行,[缺失]整行与缺失/无实测/无采样短语都抓', () => {
    const text = [
      '## 详细论证',
      '8.[缺失] 单日live_state体积、journal日均行数/字节、.data_live总量:文件不在工作区,无实测。',
      '最关键缺失:三处体积无实测——live_state单日大小、journal月增速。',
      '资源三项体积无采样,标缺失(文件不在工作区)。',
      '## 本轮变化',
      '新缺口:体积三项仍缺du采样,T01前需补。',
    ].join('\n')
    const gs = parseGaps(text)
    // 同一缺口的不同说法归一后去重,条数≤行数。
    expect(gs.length).toBeGreaterThan(0)
    expect(gs.length).toBeLessThanOrEqual(4)
    expect(gs.every((g) => g.length > 0)).toBe(true)
    // 非缺口行不抓。
    expect(parseGaps('## 结论摘要\n主张并列,不收敛。')).toEqual([])
    expect(parseGaps('')).toEqual([])
  })

  it('gapAge:同一缺口存活了几轮进审计,中途补上即止', () => {
    // 缺口 g1 只在 R1 出现 → 存活 1 轮;g2 在 R2/R3 → 存活 2 轮。
    const ages = gapAge([
      { round: 1, gaps: ['体积无实测'] },
      { round: 2, gaps: ['体积无实测', 'manifest样例缺失'] },
      { round: 3, gaps: ['manifest样例缺失'] },
    ])
    expect(ages).toEqual([
      { gap: '体积无实测', firstRound: 1, lastRound: 2, age: 2 },
      { gap: 'manifest样例缺失', firstRound: 2, lastRound: 3, age: 2 },
    ])
  })

  it('缺「本轮变化」段时回落整篇比对(旧格式不破)', () => {
    const rec = toDebateRound(2, 'agree=true\nanswer=上 K8s', 'agree=true\nanswer=上K8s。', '旧文本')
    expect(rec.hasNewInfo).toBe(true)
  })
})

describe('v4 decision summary', () => {
  const mkRound = (over: Partial<DebateRound> = {}): DebateRound => ({
    round: 1, builderAnswer: '甲', builderAgree: false,
    challengerAnswer: '乙', challengerAgree: false, hasNewInfo: true, builderRelayChars: 0,
    protoVersion: STOP_PROTOCOL_VERSION, pendingItems: null,
    quoteAudit: { quotableLines: 0, quotedLines: 0, hitLines: [], hitRate: null },
    ...over,
  })

  it('制图 prompt 要求先出决策摘要再出五件套', () => {
    const p = buildSynthesizerPrompt('上不上 K8s?', '实录')
    expect(p).toContain(`## ${DECISION_SECTION}`)
    // 比段标题的顺序(角色描述里也出现了"成果地图"四个字,不能拿裸词比)。
    expect(p.indexOf(`## ${DECISION_SECTION}`)).toBeLessThan(p.indexOf('## 成果地图'))
    expect(p).toContain('建议下一步')
  })

  it('extractDecisionSummary / stripDecisionSummary 各取所需', () => {
    const t = `## ${DECISION_SECTION}\n- 结论:上。\n\n## 成果地图\n1. 视角清单\n- 甲`
    expect(extractDecisionSummary(t)).toBe('- 结论:上。')
    expect(stripDecisionSummary(t)).toBe('## 成果地图\n1. 视角清单\n- 甲')
    expect(extractDecisionSummary('没有这一段')).toBe('')
  })

  it('兜底收尾:收敛时说清收敛并给下一步', () => {
    const r = [mkRound({ round: 1, builderAgree: true, challengerAgree: true, builderAnswer: '上 K8s', challengerAnswer: '上 K8s' })]
    const s = buildFallbackSummary('上不上 K8s?', r, 'convergence')
    expect(s).toContain('## 决策摘要')
    expect(s).toContain('上 K8s')
    expect(s).toContain('共识收敛')
    expect(s).toContain('建议下一步')
    expect(s).not.toContain('未决清单')
  })

  it('兜底收尾:未收敛时给双方立场 + 未决清单', () => {
    const r = [
      mkRound({ round: 1, builderAnswer: '甲', challengerAnswer: '乙' }),
      mkRound({ round: 2, builderAnswer: '甲', challengerAnswer: '乙', pendingItems: ['查清峰值口径'] }),
    ]
    const s = buildFallbackSummary('选甲还是乙?', r, 'saturation')
    expect(s).toContain('未收敛')
    expect(s).toContain('甲')
    expect(s).toContain('焦点停滞')
    expect(s).toContain('未决清单(1 条):查清峰值口径')
    expect(s).toContain('落成待办')
  })

  it('兜底收尾:空轮次不炸', () => {
    const s = buildFallbackSummary('问题', [], null)
    expect(s).toContain('## 决策摘要')
    expect(s).toContain('未形成明确答案')
  })

  it('兜底收尾:收敛但缺口仍存活 → 加"未覆盖"声明,不拦停机', () => {
    const conv = (n: number) => mkRound({
      round: n, builderAgree: true, challengerAgree: true,
      builderAnswer: '上 K8s', challengerAnswer: '上 K8s',
    })
    const s = buildFallbackSummary('上不上 K8s?', [conv(1), conv(2)], 'convergence', 5, [
      { gap: '体积三项无采样', firstRound: 1, lastRound: 2, age: 2 },
    ])
    expect(s).toContain('共识收敛')
    expect(s).toContain('未覆盖')
    expect(s).toContain('体积三项无采样')
    expect(s).toContain('存活 2 轮')
    // 没给 gapSpans → 不写,不猜。
    const plain = buildFallbackSummary('上不上 K8s?', [conv(1), conv(2)], 'convergence', 5)
    expect(plain).not.toContain('未覆盖')
  })

  it('兜底收尾:指针审计只报数(命中 x/y),缺了也不 gate', () => {
    const r = mkRound({
      round: 1, builderAgree: true, challengerAgree: true,
      builderAnswer: '上 K8s', challengerAnswer: '上 K8s',
      pointerAudit: { total: 2, hit: 1, missing: ['docs/missing.md'], unverified: [], hitRate: 0.5 },
    })
    const s = buildFallbackSummary('上不上 K8s?', [r], 'convergence', 5)
    expect(s).toContain('出处核验')
    expect(s).toContain('命中 1 条')
    expect(s).toContain('未命中 1 条')
    expect(s).toContain('docs/missing.md')
    // 验不了的轮单独报数,不进 missing。
    const u = mkRound({
      round: 1, pointerAudit: { total: 1, hit: 0, missing: [], unverified: ['live/a.py'], hitRate: 0 },
    })
    const su = buildFallbackSummary('问?', [u], 'maxRounds', 5)
    expect(su).toContain('验不了 1 条')
    expect(su).not.toContain('未命中: ')
    // 老局(字段缺失) → 不写这行,不猜。
    const old = buildFallbackSummary('上不上 K8s?', [mkRound({ round: 1 })], 'convergence', 5)
    expect(old).not.toContain('出处核验')
  })

  it('convergedAtCap:只有"上限轮 + 真收敛"才算压线,不是提前收敛', () => {
    const last = (n: number) => mkRound({
      round: n, builderAgree: true, challengerAgree: true,
      builderAnswer: '上 K8s', challengerAnswer: '上 K8s',
    })
    const prev = (n: number) => mkRound({ round: n })
    // 5 轮上限、第 5 轮收敛 → 压线。
    expect(convergedAtCap('convergence', [prev(1), prev(2), prev(3), prev(4), last(5)], 5)).toBe(true)
    // 10 轮上限、第 10 轮收敛 → 压线。
    const ten = Array.from({ length: 9 }, (_, i) => prev(i + 1)); ten.push(last(10))
    expect(convergedAtCap('convergence', ten, 10)).toBe(true)
    // 第 3 轮就收敛(上限 5) → 提前收敛,不是压线。
    expect(convergedAtCap('convergence', [prev(1), prev(2), last(3)], 5)).toBe(false)
    // 最后一轮没收敛 → 不是压线(这是 maxRounds 跑满,走别的分支)。
    expect(convergedAtCap('convergence', [prev(1), prev(2), prev(3), prev(4), prev(5)], 5)).toBe(false)
    // 停机原因不是 convergence → 不是压线(上限是上限,别蹭共识的说法)。
    expect(convergedAtCap('saturation', [prev(1), last(2)], 2)).toBe(false)
    expect(convergedAtCap('maxRounds', [prev(1), last(2)], 2)).toBe(false)
    expect(convergedAtCap(null, [prev(1), last(2)], 2)).toBe(false)
    // 上限 1:只有一轮可谈,没有"提前 vs 压线"之分,不标。
    expect(convergedAtCap('convergence', [last(1)], 1)).toBe(false)
  })

  it('兜底收尾:压线共识明说"上限",并给加轮复验的建议', () => {
    const conv = (n: number) => mkRound({
      round: n, builderAgree: true, challengerAgree: true,
      builderAnswer: '上 K8s', challengerAnswer: '上 K8s',
    })
    const s = buildFallbackSummary('上不上 K8s?', [conv(1), conv(2), conv(3), conv(4), conv(5)], 'convergence', 5)
    expect(s).toContain('上限 5 轮')
    expect(s).toContain('压线')
    expect(s).toContain('加 1~2 轮')
    expect(s).not.toContain('共识收敛\n')
    // 同样 5 轮,但第 3 轮就收敛(给了上限 5) → 提前收敛,不标压线。
    const early = buildFallbackSummary('上不上 K8s?', [conv(1), conv(2), conv(3)], 'convergence', 5)
    expect(early).toContain('共识收敛')
    expect(early).not.toContain('压线')
    // 没给上限 → 老行为,不猜(猜上限=轮数会把提前收敛误标成撞线)。
    const unknown = buildFallbackSummary('上不上 K8s?', [conv(1), conv(2), conv(3), conv(4), conv(5)], 'convergence')
    expect(unknown).toContain('共识收敛')
    expect(unknown).not.toContain('压线')
  })
})
