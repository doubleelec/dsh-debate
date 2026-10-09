/**
 * dsh-debate — 视角模板库 v0.1(种子 4 类,见 ADR-0003)。
 * 模板只定三样:lens 维度名 + 挑战者 checklist + 证据期望。不写死话术。
 */

/** 题型四类。 */
export type QuestionType = 'selection' | 'review' | 'tradeoff' | 'causal'

/** 单个视角 lens。 */
export interface LensTemplate {
  id: string
  name: string
  description: string
}

/** 一类题型的模板:默认 lens + 挑战 checklist + 证据期望。 */
export interface QuestionTemplate {
  type: QuestionType
  label: string
  /** 适用判断:给模型的分类指引。 */
  whenToUse: string
  defaultLenses: LensTemplate[]
  challengeChecklist: string[]
  evidenceExpectation: string
}

export const LENS_TEMPLATES: Record<QuestionType, QuestionTemplate> = {
  selection: {
    type: 'selection',
    label: '选型 / 方案比较',
    whenToUse: '要在 A/B(含"要不要上 X")之间选,或比较多个方案时用。',
    defaultLenses: [
      { id: 'fit', name: '功能适配', description: '需求与方案能力的匹配度,有没有杀手级 mismatch。' },
      { id: 'cost', name: '成本', description: '采购、人力、迁移、长期持有成本,给数字。' },
      { id: 'team', name: '团队能力', description: '现有团队能否驾驭,学习曲线与招聘面。' },
      { id: 'ops', name: '运维负担', description: '上线后的日常运维、值班、升级成本。' },
      { id: 'eco', name: '生态', description: '社区、文档、插件、长期维护前景。' },
      { id: 'risk', name: '风险与可逆性', description: '选错的代价,回滚与退出成本。' },
    ],
    challengeChecklist: [
      '候选空间全吗?有没有没列出来的 C 选项?',
      '每个维度的证据在哪?成本给了数字吗?',
      '有没有只谈技术不谈组织与成本?',
    ],
    evidenceExpectation: '成本给数字;候选空间须含 C 选项;出处到文档/实测。',
  },
  review: {
    type: 'review',
    label: '评审 / 对照验证',
    whenToUse: '拿一份设计/方案对照另一份需求/指标做验证时用,如"架构满足需求吗"。',
    defaultLenses: [
      { id: 'metric', name: '指标完备', description: '需求里的性能指标抽全了吗,每条能否指到章节号。' },
      { id: 'link', name: '链路完备', description: '每个指标的关键链路(读/写/定时/异常/扩容)都有归属吗。' },
      { id: 'scene', name: '场景完备', description: '常态/峰值/异常/增长四态都过了吗。' },
      { id: 'evidence', name: '证据完备', description: '每个"能"字都有出处吗,状态是四态之一吗。' },
    ],
    challengeChecklist: [
      '没覆盖的指标:需求里写了,建构者没算的?',
      '没认领的链路:写链路、冷启动、缓存击穿、主从延迟谁认领?',
      '没过的场景:峰值系数、故障、一年后数据量有结论吗?',
      '没证据的断言:哪个"能"字没有出处?',
    ],
    evidenceExpectation: '出处到章节/图表;每格状态为已支撑/推断/缺失/矛盾四态之一。',
  },
  tradeoff: {
    type: 'tradeoff',
    label: '权衡 / 决策',
    whenToUse: '两个目标冲突要拍优先级,或"多快算够"这类度的问题时用。',
    defaultLenses: [
      { id: 'conflict', name: '目标冲突显式化', description: '冲突的双方到底是什么,有没有被偷换。' },
      { id: 'short', name: '短期代价', description: '现在付什么,谁付,付多久。' },
      { id: 'long', name: '长期代价', description: '半年、一年后回头看,代价长什么样。' },
      { id: 'counterfactual', name: '反事实', description: '如果不做会怎样,有没有比"做"更便宜的"不做"。' },
      { id: 'values', name: '价值排序', description: '谁的偏好在主导,藏了什么前提。' },
    ],
    challengeChecklist: [
      '代价是不是只算了一边?',
      '价值排序藏没藏前提?',
      '反事实挖了吗?"不做"真的不行吗?',
    ],
    evidenceExpectation: '代价两边都算;反事实必挖;价值判断只记录归属。',
  },
  causal: {
    type: 'causal',
    label: '因果 / 解释',
    whenToUse: '解释"为什么慢/为什么失败",在多个候选原因里定位时用。',
    defaultLenses: [
      { id: 'phenomenon', name: '现象', description: '到底观测到了什么,边界条件是什么。' },
      { id: 'hypotheses', name: '候选假设', description: '所有说得过去的解释,先列全再排除。' },
      { id: 'evidence-chain', name: '证据链', description: '每个假设的支持证据,事实层要出处。' },
      { id: 'alternatives', name: '替代解释', description: '还没被杀死的竞争解释。' },
      { id: 'falsification', name: '证伪条件', description: '什么证据出现会推翻当前结论。' },
    ],
    challengeChecklist: [
      '有没有只找支持证据没找反例?',
      '替代解释杀完了吗?',
      '证伪条件写了吗?什么证据出现会推翻结论?',
    ],
    evidenceExpectation: '每个假设配证伪条件;替代解释须杀完;事实层给出处。',
  },
}

/** 按题型取默认 lens id 列表。 */
export function defaultLensIds(type: QuestionType): string[] {
  return LENS_TEMPLATES[type].defaultLenses.map((l) => l.id)
}

/** 按 id 取 lens(跨题型查找,找不到返回 undefined)。 */
export function findLens(id: string): LensTemplate | undefined {
  for (const t of Object.values(LENS_TEMPLATES)) {
    const hit = t.defaultLenses.find((l) => l.id === id)
    if (hit) return hit
  }
  return undefined
}
