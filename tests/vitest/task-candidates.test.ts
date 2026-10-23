import { describe, expect, it } from 'vitest'
import {
  parsePackageDescription,
  parseModuleTomlDescription,
  parseReadmeTitle,
  topDirsOf,
  describeRepo,
  describeRepos,
  type DescDeps,
} from '../../src/cross_tasks/candidates'

/** 内存 fs:abs → 内容;没列出的文件读回 null。 */
function fakeDeps(files: Record<string, string>, dirs: Record<string, string[]> = {}): DescDeps {
  return {
    async readFile(abs: string) {
      return Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null
    },
    async readdirNames(abs: string) {
      return dirs[abs] ?? []
    },
  }
}

describe('candidates 解析器(ADR-0030)', () => {
  it('package.json description 优先,name 兜底', () => {
    expect(parsePackageDescription('{"name":"x","description":"修任务面板"}')).toBe('修任务面板')
    expect(parsePackageDescription('{"name":"@scope/x"}')).toBe('@scope/x')
    expect(parsePackageDescription('{}')).toBe(null)
    expect(parsePackageDescription('not json')).toBe(null)
    expect(parsePackageDescription(null)).toBe(null)
  })

  it('module.toml 取第一处 description', () => {
    expect(parseModuleTomlDescription('[module]\nname = "s"\ndescription = "任务服务纯逻辑"\n')).toBe('任务服务纯逻辑')
    expect(parseModuleTomlDescription('[module]\nname = "s"\n')).toBe(null)
  })

  it('README 取首个一二级标题', () => {
    expect(parseReadmeTitle('# 标题\n\n正文')).toBe('标题')
    expect(parseReadmeTitle('前言\n\n## 二级\n')).toBe('二级')
    expect(parseReadmeTitle('没有标题')).toBe(null)
  })

  it('topDirs 跳点目录/node_modules,限 6 个', () => {
    expect(topDirsOf(['src', '.git', 'tests', 'node_modules', 'docs'])).toBe('目录 docs src tests')
    expect(topDirsOf([])).toBe('')
  })
})

describe('describeRepo 优先级', () => {
  it('package.json > module.toml > README > 目录', async () => {
    const withPkg = fakeDeps(
      { 'D:/w/r/package.json': '{"description":"包描述"}', 'D:/w/r/README.md': '# 标题' },
    )
    expect(await describeRepo('D:/w/r', withPkg)).toBe('包描述')

    const withToml = fakeDeps(
      { 'D:/w/r/src/module.toml': 'description = "模块描述"\n', 'D:/w/r/README.md': '# 标题' },
    )
    expect(await describeRepo('D:/w/r', withToml)).toBe('模块描述')

    const withReadme = fakeDeps({ 'D:/w/r/README.md': '# 标题\n' })
    expect(await describeRepo('D:/w/r', withReadme)).toBe('标题')

    const bare = fakeDeps({}, { 'D:/w/r': ['src', 'tests'] })
    expect(await describeRepo('D:/w/r', bare)).toBe('目录 src tests')

    const empty = fakeDeps({}, {})
    expect(await describeRepo('D:/w/r', empty)).toBe('')
  })

  it('长描述截断到 120 字', async () => {
    const deps = fakeDeps({ 'D:/w/r/package.json': JSON.stringify({ description: 'a'.repeat(300) }) })
    const d = await describeRepo('D:/w/r', deps)
    expect(d.length).toBe(120)
    expect(d.endsWith('…')).toBe(true)
  })
})

describe('describeRepos 批量', () => {
  it('逐仓给自述,读失败的仓不进 map', async () => {
    const deps = fakeDeps(
      { 'D:/w/a/package.json': '{"description":"A 仓"}' },
      { 'D:/w/b': ['src'] },
    )
    const out = await describeRepos(
      [{ relPath: 'a', absPath: 'D:/w/a' }, { relPath: 'b', absPath: 'D:/w/b' }],
      deps,
    )
    expect(out).toEqual({ a: 'A 仓', b: '目录 src' })
  })

  it('缺 absPath 的条目跳过', async () => {
    const out = await describeRepos([{ relPath: 'x', absPath: '' }], fakeDeps({}))
    expect(out).toEqual({})
  })
})
