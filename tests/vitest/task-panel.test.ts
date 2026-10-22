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
  suggestTitleFromDraft,
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
  it('parentRoot 下 .tasks(斜杠归一)', () => {
    expect(suggestTasksRoot('D:\\finance\\cross-tasks')).toBe('D:/finance/cross-tasks/.tasks')
    expect(suggestTasksRoot('/f/cross-tasks/')).toBe('/f/cross-tasks/.tasks')
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

  it('合法 slug 通过', () => {
    expect(validateSlug('broker-empty-semantics')).toBe(null)
    expect(validateSlug('a1')).toBe(null)
  })
})

describe('validateTaskBuild', () => {
  const good = { slug: 'demo', lead: 'libs/a', involved: ['libs/a'], tasksRoot: '/t/.tasks' }

  it('全齐通过', () => {
    expect(validateTaskBuild(good)).toBe(null)
  })

  it('按 slug→lead→involved→tasksRoot 顺序报首个缺项', () => {
    expect(validateTaskBuild({ ...good, slug: '' })).toContain('slug')
    expect(validateTaskBuild({ ...good, lead: '' })).toContain('牵头仓')
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
  it('ADR-0028:只定 slug,不预勾选不牵头(等 recommend 再合并)', () => {
    const d = suggestScanDefaults('D:/work/finance', [
      { relPath: 'libs/broker', kind: 'repo' },
      { relPath: 'data', kind: 'external' },
      { relPath: 'quant/x', kind: 'repo' },
      { relPath: 'plain', kind: 'unknown' },
    ])
    expect(d.checked).toEqual([])
    expect(d.lead).toBe('')
    expect(d.slug).toBe('finance')
    expect(d.title).toBe('finance')
  })

  it('无 repo 时 slug 回退 task', () => {
    const d = suggestScanDefaults('', [{ relPath: 'plain', kind: 'unknown' }])
    expect(d.checked).toEqual([])
    expect(d.lead).toBe('')
    expect(d.slug).toBe('task')
  })

  it('中文/空格父目录名清洗成可用 slug', () => {
    const d = suggestScanDefaults('D:/工作/我的 仓', [{ relPath: 'a', kind: 'repo' }])
    expect(d.slug).toBe('task')
  })
})

describe('suggestTitleFromDraft', () => {
  it('空白折叠后取前 40 字,超长加省略号', () => {
    expect(suggestTitleFromDraft('  修 broker\n的空语义  ')).toBe('修 broker 的空语义')
    const long = 'a'.repeat(50)
    expect(suggestTitleFromDraft(long)).toBe(`${'a'.repeat(40)}…`)
  })

  it('空草稿回空(调用方再回退 slug)', () => {
    expect(suggestTitleFromDraft('')).toBe('')
    expect(suggestTitleFromDraft('   \n  ')).toBe('')
  })
})

describe('applyRecommendDefaults', () => {
  const found = [
    { relPath: 'libs/broker', kind: 'repo' },
    { relPath: 'quant/x', kind: 'repo' },
    { relPath: 'plain', kind: 'unknown' },
  ]

  it('推荐与扫描求交,保推荐序,lead 取首个', () => {
    const d = applyRecommendDefaults(found, ['quant/x', 'libs/broker'])
    expect(d.checked).toEqual(['quant/x', 'libs/broker'])
    expect(d.lead).toBe('quant/x')
  })

  it('未知仓/unknown/external 被过滤,去重', () => {
    const d = applyRecommendDefaults(found, ['nope', 'libs/broker', 'libs/broker', 'plain'])
    expect(d.checked).toEqual(['libs/broker'])
    expect(d.lead).toBe('libs/broker')
  })

  it('都不中则空选(提示手勾)', () => {
    expect(applyRecommendDefaults(found, [])).toEqual({ checked: [], lead: '' })
    expect(applyRecommendDefaults(found, ['nope'])).toEqual({ checked: [], lead: '' })
  })
})
