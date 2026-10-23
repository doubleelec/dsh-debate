import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pluginDefault from '../../src/index'

const { apply } = pluginDefault as unknown as { apply(ctx: never): void }

/** fake ctx:假 agents/registry + 真路由 handler(沿用 launcher 的 fake 测法)。 */
function makeCtx(recommendText?: string): {
  ctx: never
  routes: Array<{ path: string; handler(req: unknown, res: unknown): Promise<unknown> }>
  created: unknown[]
  attached: unknown[]
  prompts: string[]
} {
  const routes: Array<{ path: string; handler(req: unknown, res: unknown): Promise<unknown> }> = []
  const created: unknown[] = []
  const attached: unknown[] = []
  const prompts: string[] = []
  const agents = {
    async create(args: never): Promise<unknown> {
      created.push(args)
      const sid = (args as { sessionId: unknown }).sessionId
      return {
        agent: { session: { id: sid }, followup(): void {} },
        async dispose(): Promise<void> {},
      }
    },
  }
  const registry = {
    async resolveByPath(cwd: string): Promise<unknown> {
      return { id: 'ws-test', path: cwd, async attachSession(sid: unknown): Promise<void> { attached.push(sid) } }
    },
    async create(cwd: string): Promise<unknown> {
      return { id: 'ws-new', path: cwd, async attachSession(sid: unknown): Promise<void> { attached.push(sid) } }
    },
  }
  const ctx = {
    get(name: string): unknown {
      if (name === 'agents') return agents
      // 推荐桩:用注文当模型输出(无注文时抛,走 ok:false 分支)。
      if (name === 'subagents') {
        return {
          async start(_kind: unknown, args: unknown): Promise<never> {
            if (recommendText === undefined) throw new Error('no subagents in route test')
            const text = recommendText
            const blocks = (args as { prompt?: Array<{ text?: string }> })?.prompt ?? []
            prompts.push(blocks.map((b) => String(b?.text ?? '')).join('\n'))
            return {
              result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
              async dispose(): Promise<void> {},
            } as never
          },
        }
      }
      if (name === 'workspaceRegistry') return registry
      if (name === 'agentPresets') {
        return {
          defaultId: 'standard',
          defaultProvider: 'local-proxy',
          defaultModel: 'opencode-muse-spark-1.3',
          async mount(): Promise<void> {},
        }
      }
      if (name === 'storage') return undefined
      return undefined
    },
    webServer: { register(r: never): void { routes.push(r as never) } },
    logger: { info(): void {}, warn(): void {} },
    effect(): () => void { return () => {} },
  }
  return { ctx: ctx as never, routes, created, attached, prompts }
}

function fakeReq(payload: unknown): unknown {
  return {
    url: '',
    method: 'POST',
    headers: {},
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> { yield JSON.stringify(payload) },
  }
}

async function call(
  routes: Array<{ path: string; handler(req: unknown, res: unknown): Promise<unknown> }>,
  routePath: string,
  payload: unknown,
): Promise<Record<string, never>> {
  const r = routes.find((x) => x.path === routePath)
  if (!r) throw new Error(`route missing: ${routePath}`)
  let body = ''
  await r.handler(fakeReq(payload), { writeHead(): void {}, end(b: unknown): void { body = String(b) } })
  return JSON.parse(body) as Record<string, never>
}

const { ctx, routes, created, attached } = makeCtx()
apply(ctx)

const tmpBase = join(tmpdir(), `dsh-session-enhance-task-routes-${Date.now()}`)
mkdirSync(tmpBase, { recursive: true })

describe('task routes(面板 HTTP 路由,ADR-0025)', () => {
  it('routes: /api/task/* 十路由注册(ADR-0030 log + ADR-0031 models)', () => {
    const taskPaths = routes.map((r) => r.path).filter((p) => p.startsWith('/dsh-session-enhance/api/task/')).sort()
    expect(taskPaths).toEqual([
      '/dsh-session-enhance/api/task/build',
      '/dsh-session-enhance/api/task/collect',
      '/dsh-session-enhance/api/task/launch',
      '/dsh-session-enhance/api/task/models',
      '/dsh-session-enhance/api/task/recommend',
      '/dsh-session-enhance/api/task/recommend/log',
      '/dsh-session-enhance/api/task/report',
      '/dsh-session-enhance/api/task/scan',
      '/dsh-session-enhance/api/task/stop',
      '/dsh-session-enhance/api/task/version',
    ])
  })

  it('routes: scan/build/launch/report/collect 全链路(fake ctx + 真盘临时目录)', async () => {
    const scanRoot = join(tmpBase, 'scanroot')
    mkdirSync(join(scanRoot, 'projA', '.git'), { recursive: true })
    mkdirSync(join(scanRoot, 'plain'), { recursive: true })
    const s = await call(routes, '/dsh-session-enhance/api/task/scan', { parentRoot: scanRoot })
    expect(s.ok).toBe(true)
    const byRel = new Map((s.repos as Array<{ relPath: string; kind: string }>).map((r) => [r.relPath, r]))
    expect(byRel.get('projA')!.kind).toBe('repo')
    expect(byRel.get('plain')!.kind).toBe('unknown')

    // build:模板内联传(不依赖 finance 真身文件,通用落点最小约束)。
    const tasksRoot = join(tmpBase, 'tasks')
    const b = await call(routes, '/dsh-session-enhance/api/task/build', {
      slug: 'routetest', involved: ['projA', 'plain'],
      title: '路由测试', tasksRoot, parentRoot: scanRoot, baselines: 'test-baseline',
      directiveTemplate: '---\nslug: <全小写英文短横线，如 broker-empty-semantics>\nversion: <YYYYMMDD_HHMMSS，与文件名时间戳一致>\nstatus: draft # draft / issued，只改新版文件，不覆盖旧版\nlead: <牵头仓路径，如 libs/broker>\ninvolved: [<仓路径1>, <仓路径2>] # 如 [libs/broker, quant/value_swing, Automatic]\ncatalog_baseline: <如 broker 0.3.3 / utils 0.2.0，抄 libs/catalog.toml>\n---\n\n# 总指示：<一句话中文标题>\n',
      toTemplate: '---\nto: <仓路径，如 libs/broker>\nslug: <与总指示同 slug>\ndirective: <同任务目录 directive.md>\ncreated: <YYYY-MM-DD HH:MM>\n---\n\n# 派活：<一句话>\n',
    })
    expect(b.ok).toBe(true)
    expect(existsSync(join(b.taskDir as string, 'directive.md'))).toBe(true)
    expect(existsSync(join(b.taskDir as string, 'to-proja.md'))).toBe(true)

    // launch:两仓会话 id 必须不同(同毫秒碰撞回归)。
    const l = await call(routes, '/dsh-session-enhance/api/task/launch', {
      taskDir: b.taskDir, involved: ['projA', 'plain'], parentRoot: scanRoot,
      provider: 'local-proxy', model: 'opencode-muse-spark-1.3',
      skipIssuedCheck: true,
    })
    expect(l.ok).toBe(true)
    expect((l.sessions as unknown[]).length).toBe(2)
    expect((l.sessions as Array<{ ok: boolean }>).every((x) => x.ok)).toBe(true)
    const sids = (l.sessions as Array<{ sessionId: string }>).map((x) => x.sessionId)
    expect(sids[0]).not.toBe(sids[1])
    expect(created.length).toBe(2)
    expect(attached.length).toBe(2)

    // report + collect:回信链路。
    const r = await call(routes, '/dsh-session-enhance/api/task/report', {
      taskDir: b.taskDir, from: 'projA', slug: 'routetest',
      ticket: 'docs/x.md', stuck: '卡在 A', change: '改 B', paths: ['p:1'],
    })
    expect(r.ok).toBe(true)
    expect((r.path as string).endsWith('back-proja.md')).toBe(true)
    const c = await call(routes, '/dsh-session-enhance/api/task/collect', { taskDir: b.taskDir })
    expect(c.ok).toBe(true)
    expect((c.backs as unknown[]).length).toBe(1)
    expect(((c.backs as Array<{ text: string }>)[0].text)).toMatch(/卡在 A/)

    // stop:控制器已空,ok 即可。
    const st = await call(routes, '/dsh-session-enhance/api/task/stop', {})
    expect(st.ok).toBe(true)

    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('routes: 参数缺失回 ok:false(不抛 500)', async () => {
    expect((await call(routes, '/dsh-session-enhance/api/task/build', {})).ok).toBe(false)
    expect((await call(routes, '/dsh-session-enhance/api/task/launch', {})).ok).toBe(false)
    expect((await call(routes, '/dsh-session-enhance/api/task/report', { taskDir: 'x' })).ok).toBe(false)
    expect((await call(routes, '/dsh-session-enhance/api/task/collect', {})).ok).toBe(false)
    expect((await call(routes, '/dsh-session-enhance/api/task/scan', {})).ok).toBe(false)
  })

  it('routes: launch 验 issued(draft 拒收,issued 放行)', async () => {
    const dir = join(tmpBase, 'issued-gate')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'directive.md'), '---\nstatus: draft\n---\n', 'utf-8')
    const scanRoot = join(tmpBase, 'scanroot2')
    mkdirSync(join(scanRoot, 'projA'), { recursive: true })
    const draft = await call(routes, '/dsh-session-enhance/api/task/launch', {
      taskDir: dir, involved: ['projA'], parentRoot: scanRoot,
    })
    expect(draft.ok).toBe(false)
    expect(String(draft.error)).toMatch(/not issued/)
    writeFileSync(join(dir, 'directive.md'), '---\nstatus: issued\n---\n', 'utf-8')
    const issued = await call(routes, '/dsh-session-enhance/api/task/launch', {
      taskDir: dir, involved: ['projA'], parentRoot: scanRoot,
    })
    expect(issued.ok).toBe(true)
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('routes: 不传模板也能建材料(内建默认,ADR-0031 消灭 ENOENT)', async () => {
    const tasksRoot2 = join(tmpBase, 'tasks-default-tpl')
    const b2 = await call(routes, '/dsh-session-enhance/api/task/build', {
      slug: 'defaulttpl', involved: ['projA'], title: '内建模板', tasksRoot: tasksRoot2,
    })
    expect(b2.ok).toBe(true)
    const text = readFileSync(join(b2.taskDir as string, 'directive.md'), 'utf-8')
    expect(text).toContain('slug: defaulttpl')
    expect(text).toContain('involved: [projA]')
    expect(text).toContain('lead: none')
  })

  it('routes: task/models 无 llm 服务时回空列表不抛(面板退化手输)', async () => {
    const m = await call(routes, '/dsh-session-enhance/api/task/models', {})
    expect(m.ok).toBe(true)
    expect(m.providers).toEqual([])
    expect(m.models).toEqual([])
  })

  it('routes: 中文路径显式报错', async () => {
    const bad = await call(routes, '/dsh-session-enhance/api/task/scan', { parentRoot: 'D:/测试/中文' })
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toMatch(/ASCII/)
    expect(readFileSync).toBeTypeOf('function')
  })
})

describe('task/recommend(ADR-0028:模型推荐涉及仓,人审核)', () => {
  const repos = [
    { relPath: 'libs/broker', kind: 'repo' },
    { relPath: 'quant/x', kind: 'repo' },
  ]

  it('routes: 正常推荐(注文桩),未知仓被过滤', async () => {
    const { ctx: c2, routes: r2 } = makeCtx(
      '{"recommended": ["quant/x", "nope"], "reasons": {"quant/x": "改动点"}, "title": "修空语义"}',
    )
    apply(c2)
    const r = await call(r2, '/dsh-session-enhance/api/task/recommend', {
      description: '修 broker 空语义', repos,
    })
    expect(r.ok).toBe(true)
    expect(r.recommended).toEqual(['quant/x'])
    expect(r.reasons).toEqual({ 'quant/x': '改动点' })
    expect(r.title).toBe('修空语义')
  })

  it('routes: description/repos 缺失回 ok:false(不抛 500)', async () => {
    const { ctx: c2, routes: r2 } = makeCtx('{}')
    apply(c2)
    expect((await call(r2, '/dsh-session-enhance/api/task/recommend', {})).ok).toBe(false)
    expect((await call(r2, '/dsh-session-enhance/api/task/recommend', { description: 'x' })).ok).toBe(false)
    expect((await call(r2, '/dsh-session-enhance/api/task/recommend', { description: 'x', repos: [] })).ok).toBe(false)
  })

  it('routes: 模型吐垃圾回 ok:false', async () => {
    const { ctx: c2, routes: r2 } = makeCtx('今天天气不错')
    apply(c2)
    const r = await call(r2, '/dsh-session-enhance/api/task/recommend', {
      description: '修 broker', repos,
    })
    expect(r.ok).toBe(false)
  })

  it('routes: 空推荐回 ok:false + 候选清单 + 原文(ADR-0030 说清原因)', async () => {
    const { ctx: c2, routes: r2 } = makeCtx('{"recommended": [], "reasons": {}, "title": "t"}')
    apply(c2)
    const r = await call(r2, '/dsh-session-enhance/api/task/recommend', {
      description: '修 broker', repos,
    })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('候选里没有相关仓')
    expect(r.candidates).toEqual(['libs/broker', 'quant/x'])
    expect(String(r.rawHead)).toContain('recommended')
  })

  it('routes: 推荐尝试落环形日志,/recommend/log 可取(ADR-0030 闭环调试)', async () => {
    const { ctx: c2, routes: r2 } = makeCtx('{"recommended": ["quant/x"], "reasons": {}, "title": "t"}')
    apply(c2)
    await call(r2, '/dsh-session-enhance/api/task/recommend', { description: '修 quant', repos })
    const log = await call(r2, '/dsh-session-enhance/api/task/recommend/log', { limit: 5 })
    expect(log.ok).toBe(true)
    const entries = log.entries as Array<Record<string, unknown>>
    expect(entries.length).toBeGreaterThan(0)
    const last = entries[entries.length - 1]
    expect(last.description).toBe('修 quant')
    expect(last.candidates).toEqual(['libs/broker', 'quant/x'])
    expect(String(last.raw)).toContain('recommended')
    expect(last.ok).toBe(true)
  })

  it('routes: 推荐提示词说"数量不是判断标准"(1/几个/全部,ADR-0030)', async () => {
    const c3 = makeCtx('{"recommended": ["quant/x"], "reasons": {}, "title": "t"}')
    apply(c3.ctx)
    await call(c3.routes, '/dsh-session-enhance/api/task/recommend', {
      description: '清理本文件夹下所有的 .tmp。', repos, parentRoot: 'D:/w',
    })
    const prompt = c3.prompts[c3.prompts.length - 1]
    expect(prompt).toContain('数量不是判断标准')
    expect(prompt).toContain('全部候选')
    expect(prompt).toContain('父目录')
  })
})
