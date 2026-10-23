import { describe, expect, it } from 'vitest'
import {
  parseInvolvedLines,
  suggestTasksRoot,
  validateSlug,
  validateTaskBuild,
  loadTaskPrefs,
  saveTaskPrefs,
  defaultParentRoot,
  suggestScanDefaults,
  suggestSlugFromText,
  applyRecommendDefaults,
} from '../../src/client/task'

describe('parseInvolvedLines', () => {
  it('空行/#注释忽略,首见序去重', () => {
    expect(parseInvolvedLines('libs/broker\n\n# 注释\nquant/x\nlibs/broker\n  \n')).toEqual(['libs/broker', 'quant/x'])
  })

  it('空文本回空数组', () => {
    expect(parseInvolvedLines('')).toEqual([])
    expect(parseInvolvedLines('\n# only\n')).toEqual([])
  })
})

describe('suggestTasksRoot', () => {
  it('parentRoot 下 .cross-tasks(斜杠归一,ADR-0033)', () => {
    expect(suggestTasksRoot('D:\\finance\\cross-tasks')).toBe('D:/finance/cross-tasks/.cross-tasks')
    expect(suggestTasksRoot('/f/cross-tasks/')).toBe('/f/cross-tasks/.cross-tasks')
  })

  it('空 parentRoot 回空', () => {
    expect(suggestTasksRoot('')).toBe('')
  })
})

describe('validateSlug', () => {
  it('空/中文/格式错各有提示', () => {
    expect(validateSlug('')).toContain('不能为空')
    expect(validateSlug('测试仓')).toContain('ASCII')
    expect(validateSlug('-abc')).toContain('小写英文')
    expect(validateSlug('Broker')).toContain('小写英文')
  })

  it('超过 20 字符被拒(ADR-0033)', () => {
    expect(validateSlug('cleanup-all-tmp-files-now')).toContain('20')
    expect(validateSlug('fix-dsh-shim')).toBe(null)
  })

  it('合法 slug 通过', () => {
    expect(validateSlug('cleanup-tmp')).toBe(null)
    expect(validateSlug('a1')).toBe(null)
  })
})

describe('validateTaskBuild', () => {
  const good = { slug: 'demo', involved: ['libs/a'], tasksRoot: '/t/.tasks' }

  it('全齐通过', () => {
    expect(validateTaskBuild(good)).toBe(null)
  })

  it('按 slug→involved→tasksRoot 顺序报首个缺项(ADR-0029 去牵头仓)', () => {
    expect(validateTaskBuild({ ...good, slug: '' })).toContain('slug')
    expect(validateTaskBuild({ ...good, involved: [] })).toContain('涉及仓')
    expect(validateTaskBuild({ ...good, tasksRoot: '' })).toContain('任务根')
  })
})

describe('task prefs(node 无 window)', () => {
  it('读偏好退化为空,不抛', () => {
    expect(loadTaskPrefs()).toEqual({ parentRoot: '', tasksRoot: '', templateDir: '', provider: '', model: '' })
  })

  it('写偏好静默,不抛', () => {
    expect(() => saveTaskPrefs({ parentRoot: 'a', tasksRoot: 'b', templateDir: '', provider: '', model: '' })).not.toThrow()
  })
})

describe('defaultParentRoot', () => {
  it('会话 cwd 原样返回,空/缺省回空', () => {
    expect(defaultParentRoot('D:/work/finance')).toBe('D:/work/finance')
    expect(defaultParentRoot('  ')).toBe('')
    expect(defaultParentRoot(null)).toBe('')
    expect(defaultParentRoot(undefined)).toBe('')
  })
})

describe('suggestScanDefaults', () => {
  it('ADR-0029:只占位,不预勾选不拟 slug(等 recommend 按描述/AI 标题覆盖)', () => {
    const d = suggestScanDefaults('D:/work/finance', [
      { relPath: 'libs/broker', kind: 'repo' },
      { relPath: 'data', kind: 'external' },
      { relPath: 'quant/x', kind: 'repo' },
      { relPath: 'plain', kind: 'unknown' },
    ])
    expect(d.checked).toEqual([])
    expect(d.slug).toBe('task')
  })

  it('参数忽略,恒回占位', () => {
    const d = suggestScanDefaults('', [{ relPath: 'plain', kind: 'unknown' }])
    expect(d.checked).toEqual([])
    expect(d.slug).toBe('task')
  })
})

describe('suggestSlugFromText', () => {
  it('中文任务靠词表给出 2-3 词短 slug(ADR-0033)', () => {
    expect(suggestSlugFromText('清理本文件夹下所有的 .tmp。')).toBe('cleanup-tmp')
    expect(suggestSlugFromText('修复 broker 的空语义')).toBe('fix-broker')
    expect(suggestSlugFromText('升级依赖并跑测试')).toBe('upgrade-test-deps')
  })

  it('英文描述取前三个词,总长不超过 20', () => {
    expect(suggestSlugFromText('Fix Broker Empty Semantics Now')).toBe('fix-broker-empty')
    expect(suggestSlugFromText('a'.repeat(50))).toBe('a'.repeat(20))
    expect(suggestSlugFromText('cleanup')).toBe('cleanup')
  })

  it('洗不出词回退 task,用户手改', () => {
    expect(suggestSlugFromText('中文全中文')).toBe('task')
    expect(suggestSlugFromText('')).toBe('task')
    expect(suggestSlugFromText('   ')).toBe('task')
  })
})

describe('applyRecommendDefaults', () => {
  const found = [
    { relPath: 'libs/broker', kind: 'repo' },
    { relPath: 'quant/x', kind: 'repo' },
    { relPath: 'plain', kind: 'unknown' },
  ]

  it('推荐与扫描求交,保推荐序去重不过 lead', () => {
    const d = applyRecommendDefaults(found, ['quant/x', 'libs/broker'])
    expect(d.checked).toEqual(['quant/x', 'libs/broker'])
  })

  it('未知仓/unknown/external 被过滤,去重', () => {
    const d = applyRecommendDefaults(found, ['nope', 'libs/broker', 'libs/broker', 'plain'])
    expect(d.checked).toEqual(['libs/broker'])
  })

  it('都不中则空选(提示手勾)', () => {
    expect(applyRecommendDefaults(found, [])).toEqual({ checked: [] })
    expect(applyRecommendDefaults(found, ['nope'])).toEqual({ checked: [] })
  })
})
