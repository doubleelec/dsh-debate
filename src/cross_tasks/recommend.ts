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
}

/** 从模型文本中提取并清洗推荐 JSON；非法直接抛错。 */
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
  const knownSet = new Set(
    (known ?? [])
      .filter((r) => r.kind === 'repo' || r.kind === 'part')
      .map((r) => String(r.relPath ?? '')),
  )
  const recommended: string[] = []
  const seen = new Set<string>()
  const rawList = Array.isArray(obj.recommended) ? obj.recommended : []
  for (const item of rawList) {
    const rel = String(item ?? '').trim()
    if (rel === '' || seen.has(rel) || !knownSet.has(rel)) continue
    seen.add(rel)
    recommended.push(rel)
  }
  const reasons: Record<string, string> = {}
  const rawReasons =
    obj.reasons !== null && typeof obj.reasons === 'object' && !Array.isArray(obj.reasons)
      ? (obj.reasons as Record<string, unknown>)
      : {}
  for (const rel of recommended) {
    const r = String(rawReasons[rel] ?? '').trim()
    if (r !== '') reasons[rel] = r
  }
  let title = String((obj as Record<string, unknown>).title ?? '').replace(/\s+/g, ' ').trim()
  if (title.length > 60) title = `${title.slice(0, 60)}…`
  return { recommended, reasons, title }
}
