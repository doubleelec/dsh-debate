import { describe, expect, it } from 'vitest'
import {
  scanParent,
  probeGit,
  parseGitdir,
  normalizeKey,
  mergeSameGitRoot,
  isExternalName,
  type FsDeps,
} from '../../src/cross_tasks/scan'

/** fake fs:map(abs -> {dir:bool, junction?:bool}) + files(abs -> content)。 */
function fakeFs(entries: Record<string, { dir: boolean; junction?: boolean }>, files: Record<string, string> = {}): FsDeps {
  const norm = (p: string): string => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const byNorm = new Map(Object.entries(entries).map(([k, v]) => [norm(k), v]))
  const fileByNorm = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  const children = new Map<string, string[]>()
  for (const [k] of byNorm) {
    const parts = k.split('/')
    const name = parts.pop()!
    const parent = parts.join('/')
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(name)
  }
  return {
    async readdirNames(abs: string): Promise<string[]> {
      const list = children.get(norm(abs))
      if (!list) throw new Error('ENOENT ' + abs)
      return [...list]
    },
    async isDirectory(abs: string): Promise<boolean> {
      const e = byNorm.get(norm(abs))
      return !!e && e.dir === true
    },
    async isJunction(abs: string): Promise<boolean> {
      const e = byNorm.get(norm(abs))
      return !!e && e.junction === true
    },
    async readFile(abs: string): Promise<string | null> {
      const c = fileByNorm.get(norm(abs))
      return c === undefined ? null : c
    },
    async exists(abs: string): Promise<boolean> {
      return byNorm.has(norm(abs)) || fileByNorm.has(norm(abs))
    },
  }
}

describe('task scan(从 dsh-task-launcher 移植)', () => {
  it('parseGitdir: 只认 gitdir: 行', () => {
    expect(parseGitdir('gitdir: ../../.git/worktrees/x')).toBe('../../.git/worktrees/x')
    expect(parseGitdir('garbage')).toBe(null)
    expect(parseGitdir(null)).toBe(null)
  })

  it('probeGit: .git 目录→本体库;.git 文件→工作树', async () => {
    const deps = fakeFs(
      { '/p/a': { dir: true }, '/p/a/.git': { dir: true }, '/p/b': { dir: true }, '/p/b/.git': { dir: false }, '/p/c': { dir: true } },
      { '/p/b/.git': 'gitdir: ../.git/worktrees/b' },
    )
    expect(await probeGit('/p/a', deps)).toEqual({ gitRoot: '/p/a', gitDir: '/p/a/.git' })
    const b = await probeGit('/p/b', deps)
    expect(b!.gitRoot).toBe('/p/b')
    expect(b!.gitDir).toBeTruthy()
    expect(await probeGit('/p/c', deps)).toBe(null)
  })

  it('scanParent: finance 形状(libs 归一 / value_swing 独立 / Automatic 独立 / data 跳过)', async () => {
    const deps = fakeFs({
      '/finance': { dir: true },
      '/finance/libs': { dir: true },
      '/finance/libs/.git': { dir: true },
      '/finance/libs/broker': { dir: true },
      '/finance/quant': { dir: true },
      '/finance/quant/value_swing': { dir: true },
      '/finance/quant/value_swing/.git': { dir: false },
      '/finance/Automatic': { dir: true },
      '/finance/Automatic/.git': { dir: true },
      '/finance/data': { dir: true, junction: true },
      '/finance/cross-tasks': { dir: true },
      '/finance/cross-tasks/.git': { dir: true },
    }, {
      '/finance/quant/value_swing/.git': 'gitdir: ../../.git/worktrees/value_swing',
    })
    const out = await scanParent('/finance', deps)
    const byRel = new Map(out.repos.map((r) => [r.relPath, r]))
    expect(byRel.get('libs')!.kind).toBe('repo')
    expect(byRel.get('Automatic')!.kind).toBe('repo')
    expect(byRel.get('cross-tasks')!.kind).toBe('repo')
    expect(byRel.get('quant/value_swing')!.kind).toBe('repo')
    expect(byRel.get('data')!.kind).toBe('external')
    expect(byRel.has('quant')).toBe(false)
  })

  it('scanParent: 父本身是库时无 .git 孩子记 part;否则 unknown', async () => {
    const withParent = fakeFs({ '/w': { dir: true }, '/w/.git': { dir: true }, '/w/docs': { dir: true } })
    const o1 = await scanParent('/w', withParent)
    expect(o1.repos.find((r) => r.relPath === 'docs')!.kind).toBe('part')

    const bare = fakeFs({ '/e': { dir: true }, '/e/notes': { dir: true } })
    const o2 = await scanParent('/e', bare)
    expect(o2.repos.find((r) => r.relPath === 'notes')!.kind).toBe('unknown')
  })

  it('normalizeKey: 跨盘符/大小写归一', () => {
    expect(normalizeKey('D:\\Users\\X\\Libs\\')).toBe(normalizeKey('d:/users/x/libs'))
  })

  it('mergeSameGitRoot: 同 gitRoot 归一(首见为主,余下进 aliases;null 不合并)', () => {
    const out = mergeSameGitRoot([
      { relPath: 'a', absPath: '/p/a', gitRoot: '/p/a', kind: 'repo' },
      { relPath: 'b', absPath: '/p/b', gitRoot: '/P/A/', kind: 'repo' },
      { relPath: 'c', absPath: '/p/c', gitRoot: '/p/c', kind: 'repo' },
      { relPath: 'x', absPath: '/p/x', gitRoot: null, kind: 'unknown' },
      { relPath: 'y', absPath: '/p/y', gitRoot: null, kind: 'unknown' },
    ])
    expect(out.length).toBe(4)
    expect(out[0]).toEqual({ relPath: 'a', absPath: '/p/a', gitRoot: '/p/a', kind: 'repo', aliases: ['b'] })
    expect(out[1].aliases).toEqual([])
    expect('aliases' in out[3]).toBe(false)
  })

  it('scanParent: externalNames 可覆盖', async () => {
    const deps = fakeFs({
      '/g': { dir: true },
      '/g/data': { dir: true },
      '/g/code': { dir: true },
      '/g/code/.git': { dir: true },
    })
    const dflt = await scanParent('/g', deps)
    expect(dflt.repos.find((r) => r.relPath === 'data')!.kind).toBe('external')
    const over = await scanParent('/g', deps, { externalNames: [] })
    expect(over.repos.find((r) => r.relPath === 'data')!.kind).toBe('unknown')
    expect(over.repos.find((r) => r.relPath === 'code')!.kind).toBe('repo')
  })

  it('isExternalName: 精确名单 + .gm_ 前缀族', () => {
    expect(isExternalName('data')).toBe(true)
    expect(isExternalName('.gm_venv')).toBe(true)
    expect(isExternalName('.gm_runtime')).toBe(true)
    expect(isExternalName('.gm_future_tool')).toBe(true)
    expect(isExternalName('libs')).toBe(false)
    expect(isExternalName('gmx')).toBe(false)
  })

  it('mergeSameGitRoot: part 不合并', () => {
    const out = mergeSameGitRoot([
      { relPath: 'docs', absPath: '/w/docs', gitRoot: '/w', kind: 'part' },
      { relPath: 'notes', absPath: '/w/notes', gitRoot: '/w', kind: 'part' },
      { relPath: 'a', absPath: '/p/a', gitRoot: '/p/a', kind: 'repo' },
    ])
    expect(out.filter((r) => r.kind === 'part').length).toBe(2)
    expect('aliases' in out.find((r) => r.relPath === 'docs')!).toBe(false)
  })

  it('scanParent: .gm_ 新成员自动 external', async () => {
    const deps = fakeFs({
      '/g': { dir: true },
      '/g/.gm_newtool': { dir: true },
    })
    const out = await scanParent('/g', deps)
    expect(out.repos.find((r) => r.relPath === '.gm_newtool')!.kind).toBe('external')
  })
})
