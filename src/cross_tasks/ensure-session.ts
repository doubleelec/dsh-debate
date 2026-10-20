/**
 * dsh-debate task 会话拉起编排 ensureGroupedSession（产品化）。
 *
 * 从 dsh-task-launcher 移植（JS→TS 类型化，逻辑逐行同源；原注释保留出处）。
 * 决策骨架（trim 后只留顺序与形状）：
 *   resolveByPath ?? create  →  agents.create({meta:{cwd, agentPreset}, agentOptions, setup})
 *     → resolveByPath.attachSession(sessionId)  →  followup({role:'user', content, source})
 *
 * 分组归属三道门（缺一不可）：① meta.cwd → header.cwd 落盘且桶落对；
 * ② workspace 注册存在（resolve 或 create）；③ attachSession 挂进分组。
 * 直调 agents.create 只过第 ① 道，所以第 ③ 道必须显式调。
 *
 * 全部依赖注入（ctx.get / agents / registry），不起真 agent、不调真 registry、不写盘 —— 可单测。
 */

export interface EnsureDeps {
  get(name: string): unknown
  agents: {
    create(options: {
      sessionId: string
      meta?: { cwd?: string; agentPreset?: string }
      agentOptions?: { provider?: string; model?: string }
      signal?: AbortSignal
      setup?: (agentCtx: unknown) => void | Promise<void>
    }): Promise<{ agent?: { followup?: (msg: unknown) => void } }>
  }
  nowMs?(): number
  randomId?(): string
}

export interface EnsureOpts {
  cwd: string
  text: string
  sessionId?: string
  provider?: string
  model?: string
  signal?: AbortSignal
}

interface WorkspaceLike {
  id: string
  attachSession(sid: string): Promise<void>
}

interface RegistryLike {
  resolveByPath(cwd: string): Promise<WorkspaceLike | null | undefined>
  create(cwd: string): Promise<WorkspaceLike>
}

interface PresetsLike {
  defaultId?: unknown
  defaultProvider?: unknown
  defaultModel?: unknown
  mount?(agentCtx: unknown, id: string): Promise<unknown>
}

export const tempSessionHandles = new Map<string, unknown>()

/**
 * provider/model 调用方显式传；缺省时读宿主 agentPresets 上的默认
 * （若宿主不提供则显式报错，不静默写死旧值）。
 * signal 透传给 agents.create（照抄 debate driveResident 建对：create 收 signal，
 * 被 abort 时宿主侧中断在途建会话；不传则与之前一致）。
 */
export async function ensureGroupedSession(
  deps: EnsureDeps,
  opts: EnsureOpts,
): Promise<{ sessionId: string; workspaceId: string; createdWorkspace: boolean }> {
  const { get, agents } = deps
  const nowMs = deps.nowMs ?? Date.now
  const randomId = deps.randomId ?? (() => Math.random().toString(36).slice(2, 10))
  if (!agents || typeof agents.create !== 'function') throw new Error('agents.create unavailable')
  const registry = get('workspaceRegistry') as RegistryLike | undefined
  if (!registry) throw new Error('workspaceRegistry unavailable')
  if (!opts || typeof opts.cwd !== 'string' || opts.cwd === '') throw new Error('cwd required')
  if (typeof opts.text !== 'string' || opts.text === '') throw new Error('text required')

  const presets = get('agentPresets') as PresetsLike | undefined
  // 宿主 defaultId 总是非空 string（preset-registry 包明示）；空值只出现在 fake/未知宿主，视作无 preset。
  const presetId = typeof presets?.defaultId === 'string' && presets.defaultId !== '' ? presets.defaultId : null
  const canMount = presets !== null && presets !== undefined
    && typeof presets.mount === 'function' && presetId !== null

  // ① 保分组存在（幂等：有则拿，无则建）。
  const existing = await registry.resolveByPath(opts.cwd)
  let workspaceId: string
  let createdWorkspace = false
  if (existing) {
    workspaceId = existing.id
  } else {
    const created = await registry.create(opts.cwd)
    workspaceId = created.id
    createdWorkspace = true
  }

  // ② 建会话（根形状：meta 只带 cwd + agentPreset，不传 parentAgent、不写 lineage 四件套；
  // agentOptions.model 供 persona-prefix 的 {{model}}，漏了接不了话 —— 原型实测坑位）。
  // 默认 id 带随机后缀：同任务多仓同毫秒 launch 时 Date.now() 会撞（04 冒烟实测）。
  // provider/model 不写死：调用方显式 > 宿主 presets 默认 > 显式报错（不静默错配旧值）。
  const sessionId = opts.sessionId ?? `task-session-${nowMs().toString(36)}-${randomId()}`
  const provider = opts.provider ?? (typeof presets?.defaultProvider === 'string' ? presets.defaultProvider : null)
  const model = opts.model ?? (typeof presets?.defaultModel === 'string' ? presets.defaultModel : null)
  if (typeof provider !== 'string' || provider === '') {
    throw new Error('provider required (pass launch provider, or host agentPresets.defaultProvider)')
  }
  if (typeof model !== 'string' || model === '') {
    throw new Error('model required (pass launch model, or host agentPresets.defaultModel)')
  }
  const handle = await agents.create({
    sessionId,
    meta: {
      cwd: opts.cwd,
      ...(presetId !== null ? { agentPreset: presetId } : {}),
    },
    agentOptions: { provider, model },
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(canMount
      ? { setup: async (agentCtx: unknown) => { await presets!.mount!(agentCtx, presetId!) } }
      : {}),
  })

  // ③ 挂进分组（幂等；失败会话仍在，可重试，不丢东西）。
  const ws = existing ?? await registry.resolveByPath(opts.cwd)
  if (!ws) throw new Error(`workspace lost after create: ${opts.cwd}`)
  await ws.attachSession(sessionId)
  tempSessionHandles.set(sessionId, handle)

  // ④ 首句派活（照抄 driveResidentOnce 的 followup 四件套）。
  const agent = handle.agent
  if (!agent || typeof agent.followup !== 'function') throw new Error('created agent has no followup')
  agent.followup({
    id: `task-session-${nowMs().toString(36)}-${randomId()}`,
    role: 'user',
    content: [{ type: 'text', text: opts.text }],
    source: { kind: 'user' },
  })

  return { sessionId, workspaceId, createdWorkspace }
}

/** 测试/清理用：清掉模块级句柄表（不 dispose 真东西，只清引用）。 */
export function clearTempHandles(): void {
  tempSessionHandles.clear()
}
