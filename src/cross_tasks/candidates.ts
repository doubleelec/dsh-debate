/**
 * dsh-session-enhance 候选仓自述（纯逻辑 + 注入 fs，可单测）。
 *
 * ADR-0030：分仓员只看 `relPath (kind)` 时无从判断——描述里没点名仓名，
 * 它只能回空数组。本模块给每个候选补一行自述，来源优先级：
 *   package.json 的 description → module.toml 的 description →
 *   README 首个 markdown 标题 → 顶层目录名单（兜底，至少让模型知道仓长什么样）。
 * 只读小文件，不递归、不 grep，成本可控。
 */

export interface DescDeps {
  readFile(abs: string): Promise<string | null>
  readdirNames(abs: string): Promise<string[]>
}

/** 自述最大长度（一行，防长 description 灌爆 prompt）。 */
export const DESC_MAX = 120

function joinAbs(dir: string, name: string): string {
  return `${String(dir).replace(/[\\/]+$/, '')}/${name}`
}

function clip(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= DESC_MAX) return t
  return `${t.slice(0, DESC_MAX - 1)}…`
}

/** package.json → description；解析失败/缺字段回 null。 */
export function parsePackageDescription(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>
    const d = typeof pkg.description === 'string' ? pkg.description.trim() : ''
    if (d !== '') return d
    const n = typeof pkg.name === 'string' ? pkg.name.trim() : ''
    return n !== '' ? n : null
  } catch {
    return null
  }
}

/** module.toml → 第一处 `description = "..."`；没有回 null。 */
export function parseModuleTomlDescription(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const m = text.match(/^[ \t]*description[ \t]*=[ \t]*["'](.+?)["']/m)
  return m && m[1].trim() !== '' ? m[1].trim() : null
}

/** README → 首个 markdown 一级/二级标题；没有回 null。 */
export function parseReadmeTitle(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{0,3}#{1,2}\s+(.+?)\s*$/)
    if (m && m[1].trim() !== '') return m[1].trim()
  }
  return null
}

/** 顶层目录名单（跳过点目录/node_modules），最多 6 个；用于兜底自述。 */
export function topDirsOf(names: string[]): string {
  const keep = (names ?? [])
    .filter((n) => typeof n === 'string' && n !== '' && !n.startsWith('.') && n !== 'node_modules')
    .sort()
    .slice(0, 6)
  return keep.length > 0 ? `目录 ${keep.join(' ')}` : ''
}

/** 读一个仓的自述；全都没有回 ''（prompt 里就不加破折号）。 */
export async function describeRepo(absPath: string, deps: DescDeps): Promise<string> {
  const roots = [absPath, joinAbs(absPath, 'src')]
  for (const root of roots) {
    const desc = parsePackageDescription(await safeRead(joinAbs(root, 'package.json'), deps))
    if (desc !== null) return clip(desc)
  }
  for (const root of roots) {
    const desc = parseModuleTomlDescription(await safeRead(joinAbs(root, 'module.toml'), deps))
    if (desc !== null) return clip(desc)
  }
  const title = parseReadmeTitle(await safeRead(joinAbs(absPath, 'README.md'), deps))
  if (title !== null) return clip(title)
  const names = await safeList(absPath, deps)
  return clip(topDirsOf(names))
}

/** 批量：relPath → 自述（没有的仓不进 map）。 */
export async function describeRepos(
  repos: Array<{ relPath: string; absPath: string }>,
  deps: DescDeps,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const r of repos ?? []) {
    if (!r || typeof r.relPath !== 'string' || typeof r.absPath !== 'string') continue
    try {
      const d = await describeRepo(r.absPath, deps)
      if (d !== '') out[r.relPath] = d
    } catch {
      /* 单个仓读失败不影响其余候选 */
    }
  }
  return out
}

async function safeRead(abs: string, deps: DescDeps): Promise<string | null> {
  try {
    return await deps.readFile(abs)
  } catch {
    return null
  }
}

async function safeList(abs: string, deps: DescDeps): Promise<string[]> {
  try {
    return await deps.readdirNames(abs)
  } catch {
    return []
  }
}

export function defaultDescDeps(): DescDeps {
  return {
    async readFile(abs: string) {
      const fs = await import('node:fs')
      try {
        return await fs.promises.readFile(abs, 'utf-8')
      } catch {
        return null
      }
    },
    async readdirNames(abs: string) {
      const fs = await import('node:fs')
      try {
        return await fs.promises.readdir(abs)
      } catch {
        return []
      }
    },
  }
}
