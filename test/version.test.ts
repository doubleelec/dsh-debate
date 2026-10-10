import { describe, expect, it } from 'vitest'
import { assessVersions, BUILD_VERSION, isClientStale } from '../src/version'

describe('version truth', () => {
  const START = 1_700_000_000_000

  it('BUILD_VERSION 是构建期内联的非空版本号', () => {
    expect(typeof BUILD_VERSION).toBe('string')
    expect(BUILD_VERSION.trim()).not.toBe('')
    expect(BUILD_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('三者一致 → 不 stale(健康态:显示的版本就是正在跑的版本)', () => {
    expect(assessVersions({ running: '0.4.0', disk: '0.4.0', bundleMtimeMs: START - 1000, startedAtMs: START }))
      .toEqual({ stale: false, reason: null })
  })

  it('磁盘版本更新(典型:构建完没重启宿主)→ stale 且原因含两个版本号', () => {
    const v = assessVersions({ running: '0.3.0', disk: '0.4.0', bundleMtimeMs: START - 1000, startedAtMs: START })
    expect(v.stale).toBe(true)
    expect(v.reason).toContain('v0.4.0')
    expect(v.reason).toContain('v0.3.0')
    expect(v.reason).toContain('重启')
  })

  it('bundle 启动后重建但忘了 bump 版本 → 仍判 stale(版本号之外的安全网)', () => {
    const v = assessVersions({ running: '0.4.0', disk: '0.4.0', bundleMtimeMs: START + 1000, startedAtMs: START })
    expect(v.stale).toBe(true)
    expect(v.reason).toContain('bump')
    expect(v.reason).toContain('构建前')
  })

  it('两边证据同时成立时优先报"磁盘已是新版本"(信息更具体)', () => {
    const v = assessVersions({ running: '0.3.0', disk: '0.4.0', bundleMtimeMs: START + 1000, startedAtMs: START })
    expect(v.stale).toBe(true)
    expect(v.reason).toContain('v0.4.0')
    expect(v.reason).toContain('启动后被重新构建')
  })

  it('磁盘读不到(只有 running 可信)→ 不误报 stale,但也不能掩盖 mtime 证据', () => {
    expect(assessVersions({ running: '0.4.0', disk: null, bundleMtimeMs: null, startedAtMs: START }).stale).toBe(false)
    // mtime 仍可独立定案。
    expect(assessVersions({ running: '0.4.0', disk: null, bundleMtimeMs: START + 1, startedAtMs: START }).stale).toBe(true)
  })

  it('空字符串版本号不参与比较(避免读到坏 manifest 就报 stale)', () => {
    expect(assessVersions({ running: '0.4.0', disk: '  ', bundleMtimeMs: null, startedAtMs: START }).stale).toBe(false)
  })

  it('isClientStale 只比字符串相等,区分"界面旧"与"后台旧"', () => {
    expect(isClientStale('0.4.0', '0.4.0')).toBe(false)
    expect(isClientStale('0.3.0', '0.4.0')).toBe(true)
  })

  it('集成:真实磁盘 manifest 与内联版本一致 → 不 stale(刚构建完就该是健康态)', async () => {
    const { versionFacts } = await import('../src/index')
    const facts = await versionFacts()
    // 内联版本必须等于磁盘 manifest 版本,否则"版本号代表真实程序版本"就不成立。
    expect(facts.running).toBe(BUILD_VERSION)
    expect(facts.disk).toMatch(/^\d+\.\d+\.\d+/)
    expect(facts.running).toBe(facts.disk)
    expect(assessVersions(facts).stale).toBe(false)
    // startedAtMs 必须落在过去,否则 mtime 比对方向会反。
    expect(facts.startedAtMs).toBeLessThanOrEqual(Date.now())
    // vitest 从源码直跑时没有 lib/index.js,mtime 只能为 null(构建产物路径由直跑断言覆盖)。
    expect(facts.bundleMtimeMs === null || Number.isFinite(facts.bundleMtimeMs)).toBe(true)
  })
})
