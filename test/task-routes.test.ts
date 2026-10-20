import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pluginDefault from '../src/index'

const { apply } = pluginDefault as unknown as { apply(ctx: never): void }

/** fake ctx:假 agents/registry/tools + 真路由 handler(沿用 launcher 的 fake 测法)。 */
function makeCtx(): {
  ctx: never
  routes: Array<{ path: string; handler(req: unknown, res: unknown): Promise<unknown> }>
  registered: Array<{ name: string; parameters: { type?: string; properties?: unknown }; execute: unknown }>
  created: unknown[]
  attached: unknown[]
} {
  const routes: Array<{ path: string; handler(req: unknown, res: unknown): Promise<unknown> }> = []
  const registered: Array<{ name: string; parameters: { type?: string; properties?: unknown }; execute: unknown }> = []
  const created: unknown[] = []
  const attached: unknown[] = []
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
      if (name === 'tools') return { register(d: never): void { registered.push(d as never) } }
      if (name === 'subagents') return { async start(): Promise<never> { throw new Error('no subagents in route test') } }
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
  return { ctx: ctx as never, routes, registered, created, attached }
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

const { ctx, routes, registered, created, attached } = makeCtx()
apply(ctx)

const tmpBase = join(tmpdir(), `dsh-debate-task-routes-${Date.now()}`)
mkdirSync(tmpBase, { recursive: true })

describe('task routes(与 tools 同源,ADR-0025)', () => {
  it('routes: /api/task/* 七路由注册 + task_* 五工具整壳 parameters', () => {
    const taskPaths = routes.map((r) => r.path).filter((p) => p.startsWith('/dsh-debate/api/task/')).sort()
    expect(taskPaths).toEqual([
      '/dsh-debate/api/task/build',
      '/dsh-debate/api/task/collect',
      '/dsh-debate/api/task/launch',
      '/dsh-debate/api/task/report',
      '/dsh-debate/api/task/scan',
      '/dsh-debate/api/task/stop',
      '/dsh-debate/api/task/version',
    ])
    const names = registered.filter((t) => t.name.startsWith('task_')).map((t) => t.name).sort()
    expect(names).toEqual(['task_build', 'task_collect', 'task_launch', 'task_report', 'task_scan'])
    for (const t of registered.filter((x) => x.name.startsWith('task_'))) {
      expect(t.parameters.type, `${t.name} parameters shell`).toBe('object')
      expect(typeof t.parameters.properties, `${t.name} properties`).toBe('object')
    }
  })

  it('routes: scan/build/launch/report/collect 全链路(fake ctx + 真盘临时目录)', async () => {
    const scanRoot = join(tmpBase, 'scanroot')
    mkdirSync(join(scanRoot, 'projA', '.git'), { recursive: true })
    mkdirSync(join(scanRoot, 'plain'), { recursive: true })
    const s = await call(routes, '/dsh-debate/api/task/scan', { parentRoot: scanRoot })
    expect(s.ok).toBe(true)
    const byRel = new Map((s.repos as Array<{ relPath: string; kind: string }>).map((r) => [r.relPath, r]))
    expect(byRel.get('projA')!.kind).toBe('repo')
    expect(byRel.get('plain')!.kind).toBe('unknown')

    // build:模板内联传(不依赖 finance 真身文件,通用落点最小约束)。
    const tasksRoot = join(tmpBase, 'tasks')
    const b = await call(routes, '/dsh-debate/api/task/build', {
      slug: 'routetest', lead: 'projA', involved: ['projA', 'plain'],
      title: '路由测试', tasksRoot, parentRoot: scanRoot, baselines: 'test-baseline',
      directiveTemplate: '---\nslug: <全小写英文短横线，如 broker-empty-semantics>\nversion: <YYYYMMDD_HHMMSS，与文件名时间戳一致>\nstatus: draft # draft / issued，只改新版文件，不覆盖旧版\nlead: <牵头仓路径，如 libs/broker>\ninvolved: [<仓路径1>, <仓路径2>] # 如 [libs/broker, quant/value_swing, Automatic]\ncatalog_baseline: <如 broker 0.3.3 / utils 0.2.0，抄 libs/catalog.toml>\n---\n\n# 总指示：<一句话中文标题>\n',
      toTemplate: '---\nto: <仓路径，如 libs/broker>\nslug: <与总指示同 slug>\ndirective: <同任务目录 directive.md>\ncreated: <YYYY-MM-DD HH:MM>\n---\n\n# 派活：<一句话>\n',
    })
    expect(b.ok).toBe(true)
    expect(existsSync(join(b.taskDir as string, 'directive.md'))).toBe(true)
    expect(existsSync(join(b.taskDir as string, 'to-proja.md'))).toBe(true)

    // launch:两仓会话 id 必须不同(同毫秒碰撞回归)。
    const l = await call(routes, '/dsh-debate/api/task/launch', {
      taskDir: b.taskDir, lead: 'projA', involved: ['projA', 'plain'], parentRoot: scanRoot,
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
    const r = await call(routes, '/dsh-debate/api/task/report', {
      taskDir: b.taskDir, from: 'projA', slug: 'routetest',
      ticket: 'docs/x.md', stuck: '卡在 A', change: '改 B', paths: ['p:1'],
    })
    expect(r.ok).toBe(true)
    expect((r.path as string).endsWith('back-proja.md')).toBe(true)
    const c = await call(routes, '/dsh-debate/api/task/collect', { taskDir: b.taskDir })
    expect(c.ok).toBe(true)
    expect((c.backs as unknown[]).length).toBe(1)
    expect(((c.backs as Array<{ text: string }>)[0].text)).toMatch(/卡在 A/)

    // stop:控制器已空,ok 即可。
    const st = await call(routes, '/dsh-debate/api/task/stop', {})
    expect(st.ok).toBe(true)

    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('routes: 参数缺失回 ok:false(不抛 500)', async () => {
    expect((await call(routes, '/dsh-debate/api/task/build', {})).ok).toBe(false)
    expect((await call(routes, '/dsh-debate/api/task/launch', {})).ok).toBe(false)
    expect((await call(routes, '/dsh-debate/api/task/report', { taskDir: 'x' })).ok).toBe(false)
    expect((await call(routes, '/dsh-debate/api/task/collect', {})).ok).toBe(false)
    expect((await call(routes, '/dsh-debate/api/task/scan', {})).ok).toBe(false)
  })

  it('routes: launch 验 issued(draft 拒收,issued 放行)', async () => {
    const dir = join(tmpBase, 'issued-gate')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'directive.md'), '---\nstatus: draft\n---\n', 'utf-8')
    const scanRoot = join(tmpBase, 'scanroot2')
    mkdirSync(join(scanRoot, 'projA'), { recursive: true })
    const draft = await call(routes, '/dsh-debate/api/task/launch', {
      taskDir: dir, involved: ['projA'], parentRoot: scanRoot,
    })
    expect(draft.ok).toBe(false)
    expect(String(draft.error)).toMatch(/not issued/)
    writeFileSync(join(dir, 'directive.md'), '---\nstatus: issued\n---\n', 'utf-8')
    const issued = await call(routes, '/dsh-debate/api/task/launch', {
      taskDir: dir, involved: ['projA'], parentRoot: scanRoot,
    })
    expect(issued.ok).toBe(true)
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('routes: 中文路径显式报错', async () => {
    const bad = await call(routes, '/dsh-debate/api/task/scan', { parentRoot: 'D:/测试/中文' })
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toMatch(/ASCII/)
    expect(readFileSync).toBeTypeOf('function')
  })
})
