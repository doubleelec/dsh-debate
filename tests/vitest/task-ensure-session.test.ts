import { describe, expect, it } from 'vitest'
import { ensureGroupedSession, tempSessionHandles, clearTempHandles } from '../../src/cross_tasks/ensure-session'

/** fake agents:record create 参数,回可 followup 的假 agent。 */
function fakeAgents(): {
  calls: unknown[]
  followups: unknown[]
  create(args: never): Promise<{ agent: { session: { id: unknown }; followup(m: unknown): void }; dispose(): Promise<void> }>
} {
  const calls: unknown[] = []
  const followups: unknown[] = []
  return {
    calls,
    followups,
    async create(args: never): Promise<{ agent: { session: { id: unknown }; followup(m: unknown): void }; dispose(): Promise<void> }> {
      calls.push(args)
      return {
        agent: {
          session: { id: (args as { sessionId: unknown }).sessionId },
          followup(m: unknown): void { followups.push(m) },
        },
        async dispose(): Promise<void> {},
      }
    },
  }
}

/** fake registry:resolve/create/attachSession 计数。 */
function fakeRegistry({ existingId = 'ws-1' }: { existingId?: string | null } = {}): {
  counts: { resolve: number; create: number; attach: unknown[] }
  setExisting(v: string | null): void
  resolveByPath(cwd: string): Promise<unknown>
  create(cwd: string): Promise<unknown>
} {
  const counts = { resolve: 0, create: 0, attach: [] as unknown[] }
  let id: string | null | undefined = existingId
  return {
    counts,
    setExisting(v: string | null): void { id = v },
    async resolveByPath(cwd: string): Promise<unknown> {
      counts.resolve++
      if (id === null || id === undefined) return undefined
      return { id, path: cwd, async attachSession(sid: unknown): Promise<void> { counts.attach.push(sid) } }
    },
    async create(cwd: string): Promise<unknown> {
      counts.create++
      id = 'ws-new'
      const selfCounts = counts
      return { id, path: cwd, async attachSession(sid: unknown): Promise<void> { selfCounts.attach.push(sid) } }
    },
  }
}

function deps({ agents, registry, presetId = 'standard', defaultProvider = 'local-proxy', defaultModel = 'opencode-muse-spark-1.3' }: {
  agents: ReturnType<typeof fakeAgents>
  registry: ReturnType<typeof fakeRegistry>
  presetId?: string
  defaultProvider?: string | null
  defaultModel?: string | null
}): never {
  return {
    get(name: string): unknown {
      if (name === 'workspaceRegistry') return registry
      if (name === 'agentPresets') {
        return {
          defaultId: presetId,
          ...(defaultProvider === null ? {} : { defaultProvider }),
          ...(defaultModel === null ? {} : { defaultModel }),
          async mount(): Promise<void> {},
        }
      }
      return undefined
    },
    agents,
    nowMs: () => 1792000000000,
    randomId: () => 'fixedid',
  } as never
}

describe('task ensureGroupedSession(从 dsh-task-launcher 移植)', () => {
  it('根形状 + attach + 首句(分组已存在)', async () => {
    clearTempHandles()
    const agents = fakeAgents()
    const registry = fakeRegistry({ existingId: 'ws-libs' })
    const out = await ensureGroupedSession(deps({ agents, registry }), {
      cwd: 'D:/fin/libs', text: '读 task/xxx/to-libs.md 干活',
    })
    expect(out.workspaceId).toBe('ws-libs')
    expect(out.createdWorkspace).toBe(false)
    expect(agents.calls.length).toBe(1)
    const c = agents.calls[0] as { sessionId: string; meta: Record<string, unknown>; agentOptions: unknown; setup: unknown }
    expect(c.sessionId.startsWith('task-session-')).toBe(true)
    expect(Object.keys(c.meta).sort()).toEqual(['agentPreset', 'cwd'])
    expect('parentSession' in c.meta).toBe(false)
    expect(c.agentOptions).toEqual({ provider: 'local-proxy', model: 'opencode-muse-spark-1.3' })
    expect(typeof c.setup).toBe('function')
    expect(registry.counts.attach).toEqual([c.sessionId])
    expect(registry.counts.create).toBe(0)
    expect(agents.followups.length).toBe(1)
    const f = agents.followups[0] as { role: string; content: unknown; source: unknown }
    expect(f.role).toBe('user')
    expect(f.content).toEqual([{ type: 'text', text: '读 task/xxx/to-libs.md 干活' }])
    expect(f.source).toEqual({ kind: 'user' })
    expect(tempSessionHandles.has(c.sessionId)).toBe(true)
  })

  it('分组缺失走 create', async () => {
    clearTempHandles()
    const agents = fakeAgents()
    const registry = fakeRegistry({ existingId: null })
    const out = await ensureGroupedSession(deps({ agents, registry }), {
      cwd: 'D:/fin/newrepo', text: 'hi', sessionId: 'task-session-fixed',
    })
    expect(out.sessionId).toBe('task-session-fixed')
    expect(out.workspaceId).toBe('ws-new')
    expect(out.createdWorkspace).toBe(true)
    expect(registry.counts.create).toBe(1)
    expect(registry.counts.attach).toEqual(['task-session-fixed'])
  })

  it('signal 透传给 agents.create', async () => {
    clearTempHandles()
    const agents = fakeAgents()
    const registry = fakeRegistry({ existingId: 'ws-1' })
    const ctl = new AbortController()
    const out = await ensureGroupedSession(deps({ agents, registry }), {
      cwd: 'D:/fin/libs', text: 'hi', signal: ctl.signal,
    })
    expect(agents.calls.length).toBe(1)
    expect((agents.calls[0] as { signal: unknown }).signal).toBe(ctl.signal)
    expect(out.sessionId).toBeTruthy()
  })

  it('registry 不可用显式报错', async () => {
    const agents = fakeAgents()
    await expect(
      ensureGroupedSession({ get: () => undefined, agents } as never, { cwd: 'D:/x', text: 'hi' }),
    ).rejects.toThrow('workspaceRegistry unavailable')
  })

  it('cwd/text 必填', async () => {
    const agents = fakeAgents()
    const registry = fakeRegistry({})
    await expect(ensureGroupedSession(deps({ agents, registry }), { cwd: '', text: 'hi' })).rejects.toThrow('cwd required')
    await expect(ensureGroupedSession(deps({ agents, registry }), { cwd: 'D:/x', text: '' })).rejects.toThrow('text required')
  })

  it('provider/model 显式优先,缺省读宿主 presets,都没有则显式报错', async () => {
    clearTempHandles()
    const agents = fakeAgents()
    const registry = fakeRegistry({ existingId: 'ws-1' })
    await ensureGroupedSession(deps({ agents, registry }), {
      cwd: 'D:/fin/libs', text: 'hi', provider: 'p-explicit', model: 'm-explicit',
    })
    expect((agents.calls.at(-1) as { agentOptions: unknown }).agentOptions).toEqual({ provider: 'p-explicit', model: 'm-explicit' })
    await ensureGroupedSession(deps({ agents, registry }), { cwd: 'D:/fin/libs', text: 'hi' })
    expect((agents.calls.at(-1) as { agentOptions: unknown }).agentOptions).toEqual({ provider: 'local-proxy', model: 'opencode-muse-spark-1.3' })
    await expect(
      ensureGroupedSession(deps({ agents, registry, defaultProvider: null, defaultModel: null }), { cwd: 'D:/x', text: 'hi' }),
    ).rejects.toThrow('provider required')
  })
})
