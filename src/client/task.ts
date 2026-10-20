/**
 * dsh-debate — Client 半区多仓任务面板纯逻辑(无 React/CSS,可单测)。
 *
 * 收自 ADR-0025 的面板约定:
 * - involved 文本框每行一个相对路径(空行/#注释忽略,首见序去重)。
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
  if (!Array.isArray(input.involved) || input.involved.length === 0) return '涉及仓不能为空(先扫描,再点「加入」)'
  if (String(input.tasksRoot ?? '').trim() === '') return '任务根目录不能为空(点「默认 .tasks」填入)'
  return null
}

export interface TaskPrefs {
  parentRoot: string
  tasksRoot: string
  templateDir: string
  provider: string
  model: string
}

const PREFS_KEY = 'dshd-task-prefs'

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
