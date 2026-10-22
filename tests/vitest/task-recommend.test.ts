import { describe, expect, it } from 'vitest'
import { parseRecommendText } from '../../src/cross_tasks/recommend'

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

  it('缺字段容忍:无 recommended 回空选', () => {
    const r = parseRecommendText('{"title": "t"}', known)
    expect(r).toEqual({ recommended: [], reasons: {}, title: 't' })
  })
})
