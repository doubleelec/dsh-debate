/**
 * dsh-session-enhance — Client 半区多仓任务面板纯逻辑(无 React/CSS,可单测)。
 *
 * 收自 ADR-0025 的面板约定(ADR-0028 修订推荐流):
 * - involved 文本框每行一个相对路径(空行/#注释忽略,首见序去重)。
 * - 打开面板自动扫:只展示结构,不预勾选;涉及仓由 task/recommend 按任务描述推荐,用户审核。
 * - tasksRoot 缺省为 parentRoot 下的 `.tasks`。
 * - launch 前校验只做"缺项"提示;issued 门与 ASCII 门由 host 如实报错,面板原文展示。
 * - 偏好(tasksRoot/parentRoot/templateDir/provider/model)存 localStorage,node 下无 window 时退化为空。
 */

export interface TaskBuildInput {
  slug: string
  lead: string
  involved: string[]
  tasksRoot: string
}

/** involved 文本框 → 去重仓列表(空行/#注释忽略,首见序)。 */
export function parseInvolvedLines(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** tasksRoot 缺省:parentRoot 下 `.tasks`(斜杠归一,尾斜杠去掉)。 */
export function suggestTasksRoot(parentRoot: string): string {
  const p = String(parentRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === '') return ''
  return `${p}/.tasks`
}

/** slug 格式提示(ASCII 小写短横线/数字):host 的 ASCII 门是底线,这里只拦明显手误。 */
export function validateSlug(slug: string): string | null {
  const s = String(slug ?? '').trim()
  if (s === '') return 'slug 不能为空'
  if (/[^\x00-\x7F]/.test(s)) return 'slug 只能用 ASCII(中文 host 会拒收)'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) return 'slug 用小写英文/数字/短横线(字母或数字开头)'
  return null
}

/** build 缺项校验:返回首个缺项的中文提示,全齐返回 null。 */
export function validateTaskBuild(input: TaskBuildInput): string | null {
  const slugErr = validateSlug(input.slug)
  if (slugErr !== null) return slugErr
  if (String(input.lead ?? '').trim() === '') return '牵头仓不能为空(点扫描结果里的「牵头」填入)'
  if (!Array.isArray(input.involved) || input.involved.length === 0) return '涉及仓不能为空(等 AI 推荐或手动勾选)'
  if (String(input.tasksRoot ?? '').trim() === '') return '任务根目录不能为空(点「默认 .tasks」填入)'
  return null
}

/**
 * 草稿启发式标题(ADR-0028):recommend 失败/未跑时的本地回退。
 * 空白折叠后取前 40 字,超长加 …;空草稿回 ''(调用方再回退 slug)。
 */
export function suggestTitleFromDraft(draft: string): string {
  const t = String(draft ?? '').replace(/\s+/g, ' ').trim()
  if (t === '') return ''
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

/**
 * 推荐合并(ADR-0028):recommend 返回的推荐仓与扫描结果求交(保推荐序、去重),
 * 只收 repo/part(unknown/external 不参任务);lead 取首个;都不中则空选 + 手勾。
 * 纯函数:面板拿到 recommend 响应后调一次,用户仍可逐项改。
 */
export function applyRecommendDefaults(
  found: ScanRepoLike[],
  recommended: string[],
): { checked: string[]; lead: string } {
  const known = new Set(
    found
      .filter((r) => r.kind === 'repo' || r.kind === 'part')
      .map((r) => r.relPath),
  )
  const checked: string[] = []
  const seen = new Set<string>()
  for (const r of recommended ?? []) {
    const rel = String(r ?? '').trim()
    if (rel === '' || seen.has(rel) || !known.has(rel)) continue
    seen.add(rel)
    checked.push(rel)
  }
  return { checked, lead: checked.length > 0 ? checked[0] : '' }
}

/** 面板打开即扫的默认 parentRoot:只用当前会话 cwd(用户拍板)。偏好里的旧值忽略,免得跨工程串台。 */
export function defaultParentRoot(sessionCwd: string | null | undefined): string {
  const c = String(sessionCwd ?? '').trim()
  return c
}

export interface ScanRepoLike {
  relPath: string
  kind: string
}

/**
 * 扫描回填(ADR-0028 修订):只定 slug(父目录末段转小写短横,中文名洗空回退 task)。
 * checked/lead 恒为空——涉及仓不再预勾选,等 task/recommend 按任务描述推荐后再
 * 经 applyRecommendDefaults 合并(ADR-0026 的"repo 全勾"已作废)。
 */
export function suggestScanDefaults(
  parentRoot: string,
  _repos: ScanRepoLike[],
): { checked: string[]; lead: string; slug: string; title: string } {
  const seg = String(parentRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  const slug = seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task'
  return { checked: [], lead: '', slug, title: slug }
}

export interface TaskPrefs {
  parentRoot: string
  tasksRoot: string
  templateDir: string
  provider: string
  model: string
}

const PREFS_KEY = 'dshe-task-prefs'

function prefsStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** 读偏好:node/无痕等拿不到 storage 时退化为空偏好,不抛。 */
export function loadTaskPrefs(): TaskPrefs {
  const empty: TaskPrefs = { parentRoot: '', tasksRoot: '', templateDir: '', provider: '', model: '' }
  try {
    const store = prefsStore()
    if (store === null) return empty
    const raw = store.getItem(PREFS_KEY)
    if (raw === null) return empty
    const p = JSON.parse(raw) as Partial<TaskPrefs>
    return {
      parentRoot: typeof p.parentRoot === 'string' ? p.parentRoot : '',
      tasksRoot: typeof p.tasksRoot === 'string' ? p.tasksRoot : '',
      templateDir: typeof p.templateDir === 'string' ? p.templateDir : '',
      provider: typeof p.provider === 'string' ? p.provider : '',
      model: typeof p.model === 'string' ? p.model : '',
    }
  } catch {
    return empty
  }
}

/** 写偏好:写失败静默(偏好丢了只是多填一次,不挡任务)。 */
export function saveTaskPrefs(p: TaskPrefs): void {
  try {
    const store = prefsStore()
    if (store === null) return
    store.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* 忽略 */
  }
}
