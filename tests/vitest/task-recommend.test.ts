import { describe, expect, it } from 'vitest'
import { parseRecommendText, matchRecommended, normalizeRepoRef } from '../../src/cross_tasks/recommend'

const known = [
  { relPath: 'libs/broker', kind: 'repo' },
  { relPath: 'quant/x', kind: 'repo' },
  { relPath: 'plain', kind: 'unknown' },
]

describe('parseRecommendText', () => {
  it('正常 JSON:推荐保序,理由只留推荐仓,标题截断', () => {
    const r = parseRecommendText(
      '先看结论：{"recommended": ["quant/x", "libs/broker"], "reasons": {"quant/x": "改动点", "libs/broker": "牵头", "other": "多余"}, "title": "修空语义"} 后续说明',
      known,
    )
    expect(r.recommended).toEqual(['quant/x', 'libs/broker'])
    expect(r.reasons).toEqual({ 'quant/x': '改动点', 'libs/broker': '牵头' })
    expect(r.title).toBe('修空语义')
  })

  it('未知仓被过滤,unknown 不参任务', () => {
    const r = parseRecommendText('{"recommended": ["nope", "libs/broker", "libs/broker", "plain"], "reasons": {}, "title": ""}', known)
    expect(r.recommended).toEqual(['libs/broker'])
    expect(r.reasons).toEqual({})
  })

  it('标题超 60 字截断,空白折叠', () => {
    const r = parseRecommendText(`{"recommended": [], "reasons": {}, "title": "  ${'字'.repeat(70)}  "}`, known)
    expect(r.title).toBe(`${'字'.repeat(60)}…`)
  })

  it('无 JSON/非法 JSON 直接抛错(路由回 ok:false)', () => {
    expect(() => parseRecommendText('推荐 libs/broker', known)).toThrow('没有 JSON')
    expect(() => parseRecommendText('{"recommended": [', known)).toThrow('解析失败')
  })

  it('缺字段容忍:无 recommended 回空选,无 slug 回空串', () => {
    const r = parseRecommendText('{"title": "t"}', known)
    expect(r).toEqual({ recommended: [], reasons: {}, title: 't', slug: '' })
  })

  it('slug 带回并清洗:大写/空格/超长都归一(ADR-0033)', () => {
    expect(parseRecommendText('{"recommended": ["libs/broker"], "slug": "Cleanup TMP"}', known).slug)
      .toBe('cleanup-tmp')
    expect(parseRecommendText('{"recommended": ["libs/broker"], "slug": "清理-tmp"}', known).slug)
      .toBe('tmp')
    expect(parseRecommendText('{"recommended": ["libs/broker"], "slug": "a-very-long-english-slug-here"}', known).slug)
      .toBe('a-very-long-english')
  })
})

describe('normalizeRepoRef / matchRecommended(ADR-0030 写法宽容)', () => {
  const repos = [
    { relPath: 'dsh-session-enhance', kind: 'repo' },
    { relPath: 'libs/broker', kind: 'repo' },
    { relPath: 'plain', kind: 'unknown' },
  ]

  it('归一:大小写/反斜杠/前后缀斜杠/./ 前缀', () => {
    expect(normalizeRepoRef('  Dsh-Session-Enhance/  ')).toBe('dsh-session-enhance')
    expect(normalizeRepoRef('.\\libs\\broker')).toBe('libs/broker')
    expect(normalizeRepoRef('./libs/broker/')).toBe('libs/broker')
  })

  it('漂移写法都能对上已知仓,输出用原始 relPath', () => {
    expect(matchRecommended(['Dsh-Session-Enhance'], repos)).toEqual(['dsh-session-enhance'])
    expect(matchRecommended(['./libs/broker/'], repos)).toEqual(['libs/broker'])
    expect(matchRecommended(['broker'], repos)).toEqual(['libs/broker'])
  })

  it('unknown/external 与完全无关的路径仍被丢弃', () => {
    expect(matchRecommended(['plain', 'nope', 'libs/broker'], repos)).toEqual(['libs/broker'])
  })

  it('reasons 用漂移键也能挂上', () => {
    const r = parseRecommendText(
      '{"recommended": ["Dsh-Session-Enhance"], "reasons": {"dsh-session-enhance/": "面板在这里"}, "title": ""}',
      repos,
    )
    expect(r.recommended).toEqual(['dsh-session-enhance'])
    expect(r.reasons).toEqual({ 'dsh-session-enhance': '面板在这里' })
  })
})
