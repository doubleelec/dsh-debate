/**
 * dsh-session-enhance task 材料构建器（纯函数，零 IO）。
 *
 * 从 dsh-task-launcher 移植（JS→TS 类型化，逻辑逐行同源）：
 * fill 表仍对 cross-tasks 的 directive_template.md / to_template.md 占位符，
 * 模板文本由调用方传入（readFile 在路由层），本模块不读盘 —— 可单测、可移植。
 */

/** 仓路径转信封短名：libs/broker→broker，quant/value_swing→value-swing，全小写。 */
export function shortName(repo: string): string {
  return repo.split('/').pop()!.replace(/_/g, '-').toLowerCase()
}

export interface FillDirectiveOpts {
  slug: string
  stamp: string
  involved: string[]
  title: string
  baseline: string
}

/**
 * 渲染 directive.md：把模板里的占位符全替换掉。
 * 缺创建时间戳/标题时由调用方给（路由层用 Date.now 拼 stamp）。
 */
export function fillDirective(
  template: string,
  opts: FillDirectiveOpts,
): string {
  const { slug, stamp, involved, title, baseline } = opts
  let text = template
  text = text.replace(
    'slug: <全小写英文短横线，如 broker-empty-semantics>', `slug: ${slug}`,
  )
  text = text.replace(
    'version: <YYYYMMDD_HHMMSS，与文件名时间戳一致>', `version: ${stamp}`,
  )
  text = text.replace(
    'status: draft # draft / issued / closed，只改新版文件，不覆盖旧版',
    'status: draft # 草稿：人审完改 issued，只改新版文件，不覆盖旧版',
  )
  // 牵头仓已取消(ADR-0029):协调位就是任务目录自身,lead 行写 none(占位必须消灭)。
  text = text.replace('lead: <牵头仓路径，如 libs/broker>', 'lead: none # 协调位见任务目录(ADR-0029 去牵头仓)')
  text = text.replace(
    'involved: [<仓路径1>, <仓路径2>] # 如 [libs/broker, quant/value_swing, Automatic]',
    `involved: [${involved.join(', ')}]`,
  )
  text = text.replace(
    'catalog_baseline: <如 broker 0.3.3 / utils 0.2.0，抄 libs/catalog.toml>',
    `catalog_baseline: ${baseline}`,
  )
  text = text.replace('# 总指示：<一句话中文标题>', `# 总指示：${title}`)
  return text
}

export interface FillToOpts {
  repo: string
  slug: string
  taskDirName: string
  title: string
  created: string
}

/** 渲染 to-\<short\>.md：可引用同目录 directive.md，不抄全文。 */
export function fillTo(template: string, opts: FillToOpts): string {
  const { repo, slug, taskDirName, title, created } = opts
  let text = template
  text = text.replace('to: <仓路径，如 libs/broker>', `to: ${repo}`)
  text = text.replace('slug: <与总指示同 slug>', `slug: ${slug}`)
  text = text.replace(
    'directive: <同任务目录 directive.md>',
    `directive: ${taskDirName}/directive.md`,
  )
  text = text.replace('created: <YYYY-MM-DD HH:MM>', `created: ${created}`)
  text = text.replace('# 派活：<一句话>', `# 派活：${title}（${repo}）`)
  return text
}

/**
 * 内建默认模板(ADR-0031):调用方不传文本、也不传 templateDir 时用它,不再去父目录
 * 找 directive_template.md——那里通常没有该文件,会直接 ENOENT 把 build 打死。
 * 占位符拼写必须与 fillDirective/fillTo 的 replace 目标逐字一致,否则残留断言会拦下。
 */
export const DEFAULT_DIRECTIVE_TEMPLATE = [
  '---',
  'slug: <全小写英文短横线，如 broker-empty-semantics>',
  'version: <YYYYMMDD_HHMMSS，与文件名时间戳一致>',
  'status: draft # draft / issued / closed，只改新版文件，不覆盖旧版',
  'lead: <牵头仓路径，如 libs/broker>',
  'involved: [<仓路径1>, <仓路径2>] # 如 [libs/broker, quant/value_swing, Automatic]',
  'catalog_baseline: <如 broker 0.3.3 / utils 0.2.0，抄 libs/catalog.toml>',
  '---',
  '',
  '# 总指示：<一句话中文标题>',
  '',
  '## 目标',
  '写清要达成的结果与可判的验收标准。',
  '',
  '## 涉及',
  '逐仓列出要改的点,各仓细节见同目录 to-*.md。',
  '',
  '## 约束',
  '- 只改本任务范围内的文件,不顺手重构无关代码。',
  '- 完成后在任务目录留回信:做了什么 / 怎么验证的 / 遗留风险。',
].join('\n')

export const DEFAULT_TO_TEMPLATE = [
  '---',
  'to: <仓路径，如 libs/broker>',
  'slug: <与总指示同 slug>',
  'directive: <同任务目录 directive.md>',
  'created: <YYYY-MM-DD HH:MM>',
  '---',
  '',
  '# 派活：<一句话>',
  '',
  '先读同目录 directive.md(总指示),只做与你仓相关的部分。',
  '',
  '## 交付',
  '1. 改动清单(文件 + 一句话说明)',
  '2. 验证方式',
  '3. 遗留问题',
].join('\n')

export interface BuildMaterialsOpts {
  slug: string
  stamp: string
  involved: string[]
  title: string
  baseline: string
  created: string
  directiveTemplate: string
  toTemplate: string
  tasksPrefix?: string
}

export interface ToFile {
  repo: string
  fileName: string
  text: string
}

/**
 * 一次构建整套任务材料（仍是纯函数：只拼文本，不写盘）。
 */
export function buildMaterials(opts: BuildMaterialsOpts): {
  taskDirName: string
  directive: string
  toFiles: ToFile[]
} {
  const {
    slug, stamp, involved, title, baseline, created,
    directiveTemplate, toTemplate, tasksPrefix = '.tasks',
  } = opts
  const taskDirName = `${slug}-${stamp}`
  const taskRef = `${tasksPrefix}/${taskDirName}`
  const directive = fillDirective(directiveTemplate, { slug, stamp, involved, title, baseline })
  const toFiles = involved.map((repo) => ({
    repo,
    fileName: `to-${shortName(repo)}.md`,
    text: fillTo(toTemplate, { repo, slug, taskDirName: taskRef, title, created }),
  }))
  return { taskDirName, directive, toFiles }
}

/** 标识符只支持 ASCII（spec 出范围：中文路径桶转义不支持，遇中文显式报错，不静默错位）。 */
export function assertAscii(value: string, name: string): void {
  if (typeof value !== 'string') return
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(value)) throw new Error(`${name} must be ASCII (no CJK): ${value}`)
}

/** 探针：模板占位是否还有残留（build 后断言用）。 */
export function leftoverPlaceholders(text: string): string[] {
  const hits: string[] = []
  for (const m of text.matchAll(/<[^<>\n]{1,60}>/g)) hits.push(m[0])
  return hits
}

/** 派活首句：执行会话唯一的上下文入口（照抄 cross-tasks 开会话清单形状）。 */
export function handoffText(taskRef: string, repo: string): string {
  const short = shortName(repo)
  return `读 ${taskRef}/to-${short}.md，同目录 directive.md 可一并读，按 §做什么干活`
}

/** 回信文件名：back-\<short\>.md（short 规则与 to 一致）。 */
export function reportFileName(from: string): string {
  return `back-${shortName(from)}.md`
}

export interface ReportMarkdownOpts {
  from: string
  to?: string
  slug: string
  ticket: string
  created: string
  stuck: string
  change: string
  paths?: string[]
}

/** 回信正文（照抄 back_template.md 形状，不引用模板文件）。to 由调用方显式传，不绑 finance。 */
export function reportMarkdown(opts: ReportMarkdownOpts): string {
  const { from, slug, ticket, created, stuck, change } = opts
  const titleLine = String(stuck).split('\n')[0]
  return [
    '---',
    'type: handoff-back',
    `from: ${from}`,
    `to: ${opts.to ?? ''}`,
    `slug: ${slug}`,
    `ticket: ${ticket}`,
    `created: ${created}`,
    '---',
    '',
    `# 回信：${titleLine}`,
    '',
    '## 卡在哪',
    '',
    stuck,
    '',
    '## 要改什么',
    '',
    change,
    '',
    '## 真身在哪',
    '',
    ...(opts.paths ?? []).map((p) => `- ${p}`),
    '',
  ].join('\n')
}
