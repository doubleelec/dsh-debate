import { describe, expect, it } from 'vitest'
import {
  shortName,
  fillDirective,
  fillTo,
  buildMaterials,
  handoffText,
  reportFileName,
  reportMarkdown,
  assertAscii,
  leftoverPlaceholders,
} from '../../src/task/materials'

// 模板用内联最小占位(与 cross-tasks directive_template.md/to_template.md 同口径)。
const DIRECTIVE_TEMPLATE = [
  '---',
  'slug: <全小写英文短横线，如 broker-empty-semantics>',
  'version: <YYYYMMDD_HHMMSS，与文件名时间戳一致>',
  'status: draft # draft / issued，只改新版文件，不覆盖旧版',
  'lead: <牵头仓路径，如 libs/broker>',
  'involved: [<仓路径1>, <仓路径2>] # 如 [libs/broker, quant/value_swing, Automatic]',
  'catalog_baseline: <如 broker 0.3.3 / utils 0.2.0，抄 libs/catalog.toml>',
  '---',
  '',
  '# 总指示：<一句话中文标题>',
  '',
].join('\n')

const TO_TEMPLATE = [
  '---',
  'to: <仓路径，如 libs/broker>',
  'slug: <与总指示同 slug>',
  'directive: <同任务目录 directive.md>',
  'created: <YYYY-MM-DD HH:MM>',
  '---',
  '',
  '# 派活：<一句话>',
  '',
].join('\n')

describe('task materials(从 dsh-task-launcher 移植)', () => {
  it('shortName: 仓路径转信封短名', () => {
    expect(shortName('libs/broker')).toBe('broker')
    expect(shortName('quant/value_swing')).toBe('value-swing')
    expect(shortName('Automatic')).toBe('automatic')
  })

  it('buildMaterials: 占位全消灭 + 文件名与 involved 一一对应', () => {
    const out = buildMaterials({
      slug: 'demo-task',
      stamp: '20261020_164022',
      lead: 'libs/broker',
      involved: ['libs/broker', 'quant/value_swing', 'Automatic'],
      title: '演示任务',
      baseline: 'broker 0.3.3 / utils 0.2.0 / ops 0.2.0',
      created: '2026-10-20 16:40',
      directiveTemplate: DIRECTIVE_TEMPLATE,
      toTemplate: TO_TEMPLATE,
    })
    expect(out.taskDirName).toBe('demo-task-20261020_164022')
    expect(out.toFiles.length).toBe(3)
    expect(out.toFiles.map((f) => f.fileName)).toEqual(['to-broker.md', 'to-value-swing.md', 'to-automatic.md'])
    expect(out.toFiles.map((f) => f.repo)).toEqual(['libs/broker', 'quant/value_swing', 'Automatic'])
    // 头占位全消灭
    for (const marker of [
      'slug: <全小写英文短横线',
      'version: <YYYYMMDD_HHMMSS',
      'lead: <牵头仓路径',
      'involved: [<仓路径1>',
      'catalog_baseline: <如 broker',
      '# 总指示：<一句话中文标题>',
      'to: <仓路径',
      'slug: <与总指示同 slug>',
      'directive: <同任务目录 directive.md>',
      'created: <YYYY-MM-DD HH:MM>',
      '# 派活：<一句话>',
    ]) {
      expect(out.directive, `directive 残留 ${marker}`).not.toContain(marker)
      for (const f of out.toFiles) expect(f.text, `${f.fileName} 残留 ${marker}`).not.toContain(marker)
    }
    expect(out.directive).toMatch(/slug: demo-task/)
    expect(out.directive).toMatch(/version: 20261020_164022/)
    expect(out.directive).toMatch(/lead: libs\/broker/)
    expect(out.directive).toMatch(/# 总指示：演示任务/)
    expect(out.toFiles[1].text).toMatch(/to: quant\/value_swing/)
  })

  it('fillDirective/fillTo: draft 标记 + directive 引用', () => {
    const d = fillDirective(DIRECTIVE_TEMPLATE, {
      slug: 's', stamp: 'T', lead: 'L', involved: ['A'], title: '题', baseline: 'base',
    })
    expect(d).toMatch(/status: draft/)
    const t = fillTo(TO_TEMPLATE, { repo: 'R', slug: 's', taskDirName: '.tasks/s-T', title: '题', created: 'C' })
    expect(t).toMatch(/directive: \.tasks\/s-T\/directive\.md/)
  })

  it('handoffText/reportFileName/reportMarkdown: 派活与回信形状', () => {
    expect(handoffText('.tasks/s-T', 'libs/broker', true)).toContain('（牵头，先落完整工作文档）')
    expect(handoffText('.tasks/s-T', 'quant/value_swing', false)).not.toContain('牵头')
    expect(reportFileName('quant/value_swing')).toBe('back-value-swing.md')
    const md = reportMarkdown({
      from: 'libs/broker', to: '', slug: 's', ticket: 'docs/x.md',
      created: '2026-10-20 16:40', stuck: '卡在 A', change: '改 B', paths: ['p:1'],
    })
    expect(md).toContain('from: libs/broker')
    expect(md).toMatch(/卡在 A/)
  })

  it('assertAscii/leftoverPlaceholders: 中文路径显式报错 + 占位探针', () => {
    expect(() => assertAscii('D:/测试/中文', 'taskDir')).toThrow('ASCII')
    expect(() => assertAscii('D:/ok/path', 'taskDir')).not.toThrow()
    expect(leftoverPlaceholders('slug: <abc>')).toEqual(['<abc>'])
    expect(leftoverPlaceholders('plain text')).toEqual([])
  })
})
