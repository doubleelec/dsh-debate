#!/usr/bin/env node
/**
 * 在受限 Windows 沙箱里跑**真实的** vitest 用例。
 *
 * 为什么需要它:`npm test` 在本机沙箱里起步即死——Vite 解析配置时会
 * `exec("net use")`,而沙箱阻断子进程管道 stdio → `spawn EPERM`(全局 AGENTS.md §五)。
 * 结果是"测试套件存在,但从不运行",这比没有测试更危险。
 *
 * 本脚本**不另写断言**:它把 tests/ 里那一份真实测试文件编译成 CJS 后用 Node 直接跑。
 * 平行断言会和真实用例漂移,那才是最坏的情况。垫片只实现用例实际用到的 matcher,
 * 遇到没实现的 matcher **抛错**(而不是静默通过),所以"垫片下全绿"不会因用错的
 * matcher 而被污染——这条已经被验证过:最初缺 `.rejects`/`not.toThrow`/`toBeCloseTo`
 * 时,它们都以失败形式暴露出来,没有一条假装通过。
 *
 * 用法:`npm run test:sandbox`
 * 退出码:0=全绿;1=有用例失败,或有测试文件被跳过。跳过必须显式可见,不许静默减覆盖。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件是 ESM,没有裸 require;编译产物是 CJS,要用 createRequire 装载。
const requireCjs = createRequire(import.meta.url)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, '.tmp', 'sandbox-suite')

// ─────────────────────────── vitest 垫片 ───────────────────────────
const tests = []
const stack = []

const fmt = (name, args) => {
  let i = 0
  return String(name).replace(/%[sdifjo]/g, () => String(args[i++]))
}
function describe(name, fn) {
  stack.push(name)
  try { fn() } finally { stack.pop() }
}
function it(name, fn) {
  tests.push({ name: [...stack, name].join(' › '), fn })
}
it.each = (table) => (name, fn) => {
  for (const row of table) {
    const args = Array.isArray(row) ? row : [row]
    tests.push({ name: [...stack, fmt(name, args)].join(' › '), fn: () => fn(...args) })
  }
}

const isObj = (v) => typeof v === 'object' && v !== null
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (!isObj(a) || !isObj(b)) return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}
const show = (v) => {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v) }
  catch { return String(v) }
}

class Assertion {
  constructor(value, negated = false) { this.value = value; this.negated = negated }
  get not() { return new Assertion(this.value, !this.negated) }
  get rejects() {
    const p = this.value
    return {
      toThrow: async (sub) => {
        try {
          await p
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          if (sub !== undefined && !msg.includes(sub)) throw new Error(`expected rejection ${show(msg)} to include ${show(sub)}`)
          return
        }
        throw new Error('expected promise to reject, but it resolved')
      },
    }
  }
  check(ok, msg) {
    if (this.negated ? ok : !ok) throw new Error(`${this.negated ? 'NOT ' : ''}${msg}`)
  }
  toBe(v) { this.check(Object.is(this.value, v), `expected ${show(this.value)} to be ${show(v)}`) }
  toEqual(v) { this.check(deepEqual(this.value, v), `expected ${show(this.value)} to equal ${show(v)}`) }
  toBeNull() { this.check(this.value === null, `expected ${show(this.value)} to be null`) }
  toBeUndefined() { this.check(this.value === undefined, `expected ${show(this.value)} to be undefined`) }
  toBeDefined() { this.check(this.value !== undefined, 'expected value to be defined') }
  toBeTypeOf(t) { this.check(typeof this.value === t, `expected typeof ${show(this.value)} to be ${t}, got ${typeof this.value}`) }
  toBeTruthy() { this.check(Boolean(this.value), `expected ${show(this.value)} to be truthy`) }
  toBeFalsy() { this.check(!this.value, `expected ${show(this.value)} to be falsy`) }
  toContain(v) {
    const ok = typeof this.value === 'string'
      ? this.value.includes(v)
      : Array.isArray(this.value) && this.value.some((x) => deepEqual(x, v))
    this.check(ok, `expected ${show(this.value)} to contain ${show(v)}`)
  }
  toMatch(re) {
    this.check(re instanceof RegExp ? re.test(this.value) : String(this.value).includes(re), `expected ${show(this.value)} to match ${re}`)
  }
  toHaveLength(n) { this.check(this.value?.length === n, `expected length ${this.value?.length} to be ${n}`) }
  toBeLessThan(n) { this.check(this.value < n, `expected ${show(this.value)} < ${n}`) }
  toBeLessThanOrEqual(n) { this.check(this.value <= n, `expected ${show(this.value)} <= ${n}`) }
  toBeGreaterThan(n) { this.check(this.value > n, `expected ${show(this.value)} > ${n}`) }
  toBeGreaterThanOrEqual(n) { this.check(this.value >= n, `expected ${show(this.value)} >= ${n}`) }
  toThrow(sub) {
    let threw = false
    let msg = ''
    try { this.value() } catch (e) { threw = true; msg = e && e.message ? e.message : String(e) }
    this.check(threw && (sub === undefined || msg.includes(sub)), threw ? `expected error ${show(msg)} to include ${show(sub)}` : 'expected function to throw, but it did not')
  }
  toBeCloseTo(n, digits = 2) { this.check(Math.abs(this.value - n) < 0.5 * 10 ** -digits, `expected ${show(this.value)} to be close to ${n}`) }
}
const expect = (v) => new Assertion(v)

// ─────────────────────────── 编译 + 打桩 ───────────────────────────
const walk = (dir, filter) => {
  const out2 = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out2.push(...walk(p, filter))
    else if (filter(p)) out2.push(p)
  }
  return out2
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// 收 .ts 与 .tsx:客户端入口是 .tsx,对应测试要能一起跑(否则覆盖率会静默缩水)。
const srcFiles = walk(path.join(root, 'src'), (p) => p.endsWith('.ts') || p.endsWith('.tsx'))
const testFiles = walk(path.join(root, 'test'), (p) => p.endsWith('.test.ts'))

const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')
const args = [
  tsc, ...srcFiles, ...testFiles,
  '--outDir', out, '--rootDir', root,
  '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node',
  '--skipLibCheck', '--esModuleInterop', '--resolveJsonModule', '--jsx', 'react-jsx',
]
// tsc 会对 index.ts 里的 import.meta 报 TS1343(那是 ESM 专属),但仍会产出可用的 JS——
// 下面就地替换掉它,所以不把 tsc 的非零退出码当致命错误,只检查产物是否齐。
// 沙箱禁止捕获子进程的管道输出(EPERM),只能用 inherit,因此这两行 TS1343 无法被过滤,属预期。
console.log('sandbox-suite: 下面 tsc 若只报 src/index.ts 的 TS1343(import.meta),那是预期的——产物仍可用。')
spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })

if (!fs.existsSync(path.join(out, 'src', 'index.js'))) {
  console.error('sandbox-suite: tsc 没有产出 src/index.js,无法继续')
  process.exit(1)
}

// 仓库是 type:module,编译产物要按 CJS 跑,所以给 src/ 与 test/ 各放一份就近标记
// (不能覆盖 out/package.json——version.ts 会 require 它当数据读)。
for (const d of ['src', 'test']) {
  fs.writeFileSync(path.join(out, d, 'package.json'), '{"type":"commonjs"}')
}
// import.meta.url 在 CJS 里是语法错误:换成等价的文件 URL。
const idx = path.join(out, 'src', 'index.js')
fs.writeFileSync(idx, `const __cjsFileUrl = require('node:url').pathToFileURL(__filename).href;\n` +
  fs.readFileSync(idx, 'utf-8').replaceAll('import.meta.url', '__cjsFileUrl'))
// versionFacts 按 import.meta.url 找 ../dsh.plugin.json,把真清单放到它期望的位置。
fs.copyFileSync(path.join(root, 'dsh.plugin.json'), path.join(out, 'dsh.plugin.json'))
// 回拨产物 mtime:上面的替换与复制都发生在**本进程启动之后**,而 versionFacts 拿
// "产物 mtime 晚于进程启动"当"构建完没重启"的证据——那正是它该报 stale 的情形。
// 健康态的时序是"先构建、后启动",所以这里必须把前提造出来,否则测的是夹具时序。
// 真实验证见 scripts 之外的一次性检查:对 lib/index.js(真实构建产物)跑同一组断言。
const past = new Date(Date.now() - 3_600_000)
fs.utimesSync(idx, past, past)

const vitestDir = path.join(out, 'node_modules', 'vitest')
fs.mkdirSync(vitestDir, { recursive: true })
fs.writeFileSync(path.join(vitestDir, 'package.json'), '{"name":"vitest","version":"0.0.0-shim","main":"index.cjs"}')
fs.writeFileSync(path.join(vitestDir, 'index.cjs'), `module.exports = { describe, it, expect }`)

// ─────────────────────────── 装载 + 执行 ───────────────────────────
// 垫片要能被编译产物 require 到,所以把 'vitest' 这个请求改接到垫片上。
const shimModule = { describe, it, expect }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vitest') return path.join(vitestDir, 'index.cjs')
  return origResolve.call(this, request, ...rest)
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vitest') return shimModule
  // 打包器把 CSS module 变成样式映射;直跑时给个空映射就够——被测的 session 逻辑不碰样式。
  if (request.endsWith('.css')) return {}
  return origLoad.call(this, request, parent, isMain)
}

const skipped = []
const loaded = []
for (const tf of testFiles) {
  const rel = path.relative(root, tf).replace(/\\/g, '/')
  const compiled = path.join(out, rel.replace(/\.ts$/, '.js'))
  if (!fs.existsSync(compiled)) { skipped.push(`${rel}: 没有编译产物`); continue }
  try {
    requireCjs(compiled)
    loaded.push(rel)
  } catch (e) {
    skipped.push(`${rel}: ${(e && e.message ? e.message : String(e)).split('\n')[0]}`)
  }
}

let pass = 0
const fails = []
for (const t of tests) {
  try { await t.fn(); pass++ } catch (e) {
    fails.push(`${t.name}\n    ${e && e.message ? e.message : String(e)}`)
  }
}

console.log(`\nsandbox-suite: 装载 ${loaded.length} 个测试文件,跳过 ${skipped.length} 个`)
for (const s of skipped) console.log(`  · 跳过 ${s}`)
console.log(`sandbox-suite: PASS ${pass}, FAIL ${fails.length} (共 ${tests.length})`)
if (fails.length) console.log(fails.map((f) => '  ✗ ' + f).join('\n'))
if (tests.length === 0) { console.error('sandbox-suite: 一个用例都没收到,视为失败'); process.exit(1) }
process.exit(fails.length > 0 || skipped.length > 0 ? 1 : 0)
