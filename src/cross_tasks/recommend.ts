/**
 * dsh-session-enhance task 涉及仓推荐输出解析（纯逻辑，无 React/CSS，可单测）。
 *
 * host `task/recommend` 路由起 one-shot 子 agent，按任务描述从扫描到的仓里
 * 挑涉及仓（ADR-0028）。模型只输出一段 JSON，本模块负责清洗：
 * - 首 `{`…末 `}` 提取，无 JSON 直接抛错（路由回 ok:false）。
 * - `recommended` 只留扫描到的已知仓（保推荐序、去重）；未知仓丢弃。
 * - `reasons` 只留推荐仓的理由；`title` 去空白截 60 字。
 */

export interface RecommendInput {
  relPath: string
  kind: string
}

export interface RecommendResult {
  recommended: string[]
  reasons: Record<string, string>
  title: string
  /** 任务英文缩写(2-3 词、≤20 字符,如 cleanup-tmp);模型没给或洗不出来是 ''。 */
  slug: string
}

/**
 * slug 清洗(ADR-0033):模型给的是"任务英文缩写",常带空格/大写/超长词。
 * 归一:小写 → 非 [a-z0-9] 转短横 → 按词边界截到 ≤20 → 去首尾横。
 */
export function sanitizeTaskSlug(raw: unknown): string {
  const words = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((w) => w !== '')
  const out: string[] = []
  let len = 0
  for (const w of words) {
    const word = w.length > 20 ? w.slice(0, 20) : w
    const add = out.length === 0 ? word.length : word.length + 1
    if (len + add > 20) {
      if (out.length === 0) out.push(word)
      break
    }
    out.push(word)
    len += add
  }
  return out.join('-')
}

/** 从模型文本中提取并清洗推荐 JSON；非法直接抛错。 */

/**
 * 仓引用归一（ADR-0030）：模型常回 `Dsh-Session-Enhance`、`dsh-session-enhance/`、
 * `./dsh-session-enhance` 等写法；严格全等下一处漂移就整单空。归一口径：
 * 去空白、反斜杠转正斜杠、去 `./` 前缀、去尾斜杠、小写。
 */
export function normalizeRepoRef(ref: string): string {
  return String(ref ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * 推荐列表与已知仓匹配（容忍写法漂移）：归一后全等 → 只给仓名时按末段匹配 →
 * 给的路径是已知仓后缀（`broker` vs `libs/broker`）。返回已知仓的原始 relPath。
 */
export function matchRecommended(rawList: unknown, known: RecommendInput[]): string[] {
  const candidates = (known ?? [])
    .filter((r) => r.kind === 'repo' || r.kind === 'part')
    .map((r) => ({ rel: String(r.relPath ?? ''), norm: normalizeRepoRef(r.relPath) }))
    .filter((c) => c.norm !== '')
  const out: string[] = []
  const seen = new Set<string>()
  const push = (rel: string): void => {
    if (seen.has(rel)) return
    seen.add(rel)
    out.push(rel)
  }
  for (const item of Array.isArray(rawList) ? rawList : []) {
    const norm = normalizeRepoRef(String(item ?? ''))
    if (norm === '') continue
    const exact = candidates.find((c) => c.norm === norm)
    if (exact) { push(exact.rel); continue }
    if (!norm.includes('/')) {
      const byBase = candidates.find((c) => c.norm.split('/').pop() === norm)
      if (byBase) { push(byBase.rel); continue }
    }
    const bySuffix = candidates.find((c) => c.norm.endsWith(`/${norm}`))
    if (bySuffix) push(bySuffix.rel)
  }
  return out
}

export function parseRecommendText(text: string, known: RecommendInput[]): RecommendResult {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  if (start < 0) throw new Error('recommend: 模型输出里没有 JSON')
  // 有左括号就是一次解析尝试:无右括号时截到串尾再 parse,失败归"解析失败"。
  const end = raw.lastIndexOf('}')
  const slice = end > start ? raw.slice(start, end + 1) : raw.slice(start)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    throw new Error('recommend: 模型输出的 JSON 解析失败')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('recommend: 模型输出不是对象')
  }
  const obj = parsed as Record<string, unknown>
  const recommended = matchRecommended(obj.recommended, known)
  const reasons: Record<string, string> = {}
  const rawReasons =
    obj.reasons !== null && typeof obj.reasons === 'object' && !Array.isArray(obj.reasons)
      ? (obj.reasons as Record<string, unknown>)
      : {}
  // 理由按归一键找回（模型可能用漂移写法当 reasons 的键）。
  const reasonByNorm = new Map<string, string>()
  for (const [k, v] of Object.entries(rawReasons)) {
    const t = String(v ?? '').trim()
    if (t !== '') reasonByNorm.set(normalizeRepoRef(k), t)
  }
  for (const rel of recommended) {
    const r = reasonByNorm.get(normalizeRepoRef(rel)) ?? ''
    if (r !== '') reasons[rel] = r
  }
  let title = String((obj as Record<string, unknown>).title ?? '').replace(/\s+/g, ' ').trim()
  if (title.length > 60) title = `${title.slice(0, 60)}…`
  const slug = sanitizeTaskSlug(obj.slug)
  return { recommended, reasons, title, slug }
}
