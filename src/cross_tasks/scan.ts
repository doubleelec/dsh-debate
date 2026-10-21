/**
 * dsh-session-enhance task 结构探测 scan（纯逻辑 + 薄 IO，可注入 fake fs 单测）。
 *
 * 从 dsh-task-launcher 移植（JS→TS 类型化，逻辑逐行同源）。
 *
 * 输入 parentRoot，输出旗下直接子目录的 git 归属：
 *   [{ relPath, absPath, gitRoot, kind }]
 * kind: 'repo'（独立检出）| 'part'（父库的一部分，如 libs/broker）|
 *       'external'（junction/外部盘/数据盘，跳过）| 'unknown'（拿不准，让人勾）
 *
 * 判定只看 git 归属：子目录下 `.git` 是目录 → 本体库；是文件（`gitdir: …`）→
 * worktree/稀疏 checkout，仍算独立工作树；都没有 → 往下探一层（容器目录如 quant/、live/）；
 * 再没有 → unknown。junction/名单目录 → external。
 * 跨盘符/大小写只做归一比较，不猜测。
 */

import fs from 'node:fs'

export const EXTERNAL_NAMES = new Set<string>([
  'data', '.gm_venv', '.gm_runtime', '.tmp', 'node_modules', '.git',
])

/**
 * 名单命中：精确名 + .gm_ 前缀族（spec externalNames 缺省名单口径；
 * finance 落点运行时目录是 .gm_ 一族，逐个枚举会漏新增）。
 */
export function isExternalName(name: string): boolean {
  if (EXTERNAL_NAMES.has(name)) return true
  return typeof name === 'string' && name.startsWith('.gm_')
}

/** 解析 .git 文件内容：`gitdir: <path>` → target；否则 null。 */
export function parseGitdir(content: string | null | undefined): string | null {
  if (typeof content !== 'string') return null
  const m = content.trim().match(/^gitdir:\s*(.+)$/)
  return m ? m[1].trim() : null
}

/** 归一比较键：斜杠统一、小写、去尾斜杠（Windows 不敏感比较用）。 */
export function normalizeKey(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** relPath 统一用正斜杠（跨平台展示一致）。 */
export function toRel(parentRoot: string, absPath: string): string {
  const a = String(parentRoot).replace(/\\/g, '/').replace(/\/+$/, '')
  const b = String(absPath).replace(/\\/g, '/').replace(/\/+$/, '')
  if (b.toLowerCase() === a.toLowerCase()) return '.'
  const prefix = a + '/'
  if (b.toLowerCase().startsWith(prefix.toLowerCase())) return b.slice(prefix.length)
  return b
}

function joinAbs(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.replace(/[/\\]+$/, '') + sep + name
}

export interface RepoEntry {
  relPath: string
  absPath: string
  gitRoot: string | null
  kind: 'repo' | 'part' | 'external' | 'unknown'
  reason?: string
  gitDir?: string | null
  aliases?: string[]
}

export interface FsDeps {
  readdirNames(abs: string): Promise<string[]>
  isDirectory(abs: string): Promise<boolean>
  isJunction(abs: string): Promise<boolean>
  readFile(abs: string): Promise<string | null>
  exists(abs: string): Promise<boolean>
}

export interface ScanOpts {
  externalNames?: string[] | Set<string>
}

/**
 * 探测 parentRoot 下的结构。
 */
export async function scanParent(
  parentRoot: string,
  deps: FsDeps = defaultDeps(),
  opts: ScanOpts = {},
): Promise<{ parentRoot: string; parentGitRoot: string | null; repos: RepoEntry[] }> {
  const external = opts.externalNames instanceof Set ? opts.externalNames
    : Array.isArray(opts.externalNames) ? new Set(opts.externalNames)
    : EXTERNAL_NAMES
  const repos: RepoEntry[] = []
  const parentGit = await probeGit(parentRoot, deps)
  let names: string[]
  try {
    names = await deps.readdirNames(parentRoot)
  } catch (e) {
    throw new Error(`scan: 读目录失败 ${parentRoot}（${(e as Error)?.message ?? e}）`)
  }
  for (const name of [...names].sort()) {
    if (name === '.' || name === '..') continue
    const abs = joinAbs(parentRoot, name)
    let isDir = false
    try {
      isDir = await deps.isDirectory(abs)
    } catch { continue }
    if (!isDir) continue // 只看目录
    // 精确名单（调用方可覆盖）+ 缺省 `.gm_` 前缀族（finance 运行时目录一族，防漏新增；
    // 显式覆盖 externalNames 时只认调用方名单，不再静默加前缀）。
    const hitReserved = external.has(name)
      || (external === EXTERNAL_NAMES && isExternalName(name))
    if (hitReserved) {
      repos.push({ relPath: name, absPath: abs, gitRoot: null, kind: 'external', reason: 'reserved-name' })
      continue
    }
    let junction = false
    try {
      junction = await deps.isJunction(abs)
    } catch { junction = false }
    if (junction) {
      repos.push({ relPath: name, absPath: abs, gitRoot: null, kind: 'external', reason: 'junction' })
      continue
    }
    const git = await probeGit(abs, deps)
    if (git) {
      repos.push({ relPath: name, absPath: abs, gitRoot: git.gitRoot, kind: 'repo', gitDir: git.gitDir })
      continue
    }
    // 无 .git：容器目录？往下探一层（quant/、live/ 口径）。
    let sub: string[] | null = null
    try {
      sub = await deps.readdirNames(abs)
    } catch { sub = null }
    if (sub) {
      let foundChild = false
      for (const child of [...sub].sort()) {
        if (child === '.' || child === '..') continue
        const cAbs = joinAbs(abs, child)
        let cDir = false
        try {
          cDir = await deps.isDirectory(cAbs)
        } catch { continue }
        if (!cDir) continue
        if (external.has(child) || (external === EXTERNAL_NAMES && isExternalName(child))) continue
        let cJunction = false
        try {
          cJunction = await deps.isJunction(cAbs)
        } catch { cJunction = false }
        if (cJunction) continue
        const cGit = await probeGit(cAbs, deps)
        if (cGit) {
          foundChild = true
          repos.push({
            relPath: `${name}/${child}`,
            absPath: cAbs,
            gitRoot: cGit.gitRoot,
            kind: 'repo',
            gitDir: cGit.gitDir,
          })
        }
      }
      if (foundChild) continue
    }
    // 父本身是库 → 无 .git 的孩子算 part；否则 unknown。
    if (parentGit) {
      repos.push({ relPath: name, absPath: abs, gitRoot: parentGit.gitRoot, kind: 'part' })
    } else {
      repos.push({ relPath: name, absPath: abs, gitRoot: null, kind: 'unknown' })
    }
  }
  return { parentRoot, parentGitRoot: parentGit ? parentGit.gitRoot : null, repos: mergeSameGitRoot(repos) }
}

/**
 * 同 gitRoot 归一（spec 同库归一口径）：同库只留一条（首见为主），余下 relPath 进 `aliases[]`。
 * 只合并 kind:'repo' 条目——part 条目共享父库 gitRoot，合并会丢入口；gitRoot 为 null 的条目不参与合并。
 */
export function mergeSameGitRoot(repos: RepoEntry[]): RepoEntry[] {
  const byKey = new Map<string, RepoEntry>()
  const out: RepoEntry[] = []
  for (const r of repos) {
    if (r.kind !== 'repo') {
      out.push(r)
      continue
    }
    const key = r.gitRoot == null ? null : normalizeKey(r.gitRoot)
    if (key == null) {
      out.push(r)
      continue
    }
    const main = byKey.get(key)
    if (!main) {
      const copy: RepoEntry = { ...r, aliases: [] }
      byKey.set(key, copy)
      out.push(copy)
    } else {
      ;(main.aliases ??= []).push(r.relPath)
    }
  }
  return out
}

/**
 * 探目录的 git 归属：`.git` 目录 → gitRoot=abs；`.git` 文件（gitdir）→ 相对目标解出 gitDir，
 * gitRoot 仍记工作树 abs（分组比较用 normalizeKey）。
 */
export async function probeGit(
  abs: string,
  deps: FsDeps,
): Promise<{ gitRoot: string; gitDir: string | null } | null> {
  const dotGit = joinAbs(abs, '.git')
  let exists = false
  try {
    exists = await deps.exists(dotGit)
  } catch { return null }
  if (!exists) return null
  let isDir = false
  try {
    isDir = await deps.isDirectory(dotGit)
  } catch { return null }
  if (isDir) return { gitRoot: abs, gitDir: dotGit }
  let content: string | null = null
  try {
    content = await deps.readFile(dotGit)
  } catch { return { gitRoot: abs, gitDir: null } }
  const target = parseGitdir(content)
  if (!target) return { gitRoot: abs, gitDir: null }
  // 相对目标按 .git 文件所在目录解（即 abs 本体）。
  const gitDir = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(target)
    ? target
    : joinAbs(abs, target.replace(/\//g, abs.includes('\\') && !abs.includes('/') ? '\\' : '/'))
  return { gitRoot: abs, gitDir }
}

export function defaultDeps(): FsDeps {
  return {
    async readdirNames(abs: string) {
      return await fs.promises.readdir(abs)
    },
    async isDirectory(abs: string) {
      try {
        const st = await fs.promises.lstat(abs)
        return st.isDirectory()
      } catch {
        return false
      }
    },
    async isJunction(abs: string) {
      try {
        const st = await fs.promises.lstat(abs)
        // junction/reparse point 或符号链接都算外部（只读探测不跟进）。
        return st.isSymbolicLink() || (typeof (st as unknown as { isReparsePoint?: () => boolean }).isReparsePoint === 'function' && (st as unknown as { isReparsePoint: () => boolean }).isReparsePoint())
      } catch {
        return false
      }
    },
    async readFile(abs: string) {
      try {
        return await fs.promises.readFile(abs, 'utf-8')
      } catch {
        return null
      }
    },
    async exists(abs: string) {
      try {
        await fs.promises.access(abs)
        return true
      } catch {
        return false
      }
    },
  }
}
