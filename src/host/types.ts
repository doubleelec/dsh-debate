/**
 * src/host/types.ts — host 内部模块共享的最小 Agent 面(S27:从 index.ts 摘出)。
 *
 * 这些 interface 只描述 host 内部接线需要的结构子集(照抄调用方的
 * 实际使用形状),不引宿主内部包。debate/ 与 cross_tasks/ 的纯逻辑
 * 不依赖这里;host 接线(index.ts + host/*)共用这里,避免循环 import。
 */

/** 最小 Agent 面:parent 身份 + 会话事件读取 + 进度镜像。 */
export interface ParentAgent {
  readonly session: {
    readonly id: string
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly { type: string; data?: unknown }[]
    events?: (fromSeq?: number) => readonly { type: string; data?: unknown }[]
    surface?: unknown
    /** 会话日志直接追加(对话区直播用:直接进 surface,不经过 inbox,不唤醒模型)。 */
    append?: (type: string, data: unknown, opts?: unknown) => unknown
  }
  [key: string]: unknown
}

/** 最小内容块面:文本块提取所需子集。 */
export interface TextContentBlock {
  readonly type: string
  readonly text?: unknown
  [key: string]: unknown
}

/** subagents.start 最小面(one-shot spawn 用)。 */
export interface SubagentsLike {
  start(provider: string, req: {
    parent: ParentAgent
    prompt: TextContentBlock[]
    label?: string
    signal: AbortSignal
    agentOptions?: { provider?: string; model?: string }
    toolFilter?: { allow?: string[]; deny?: string[] }
  }): Promise<{ result: Promise<{ output: TextContentBlock[]; stopReason: string }>; dispose(): Promise<void> }>
}

/** agents.create/get 最小面(常驻建对 + parent 查找用)。 */
export interface AgentsLike {
  get(id: string): unknown
  list(): Array<{ session?: { id: string } }>
  create(options: {
    sessionId: string
    parentAgent?: unknown
    meta?: { cwd?: string; parentSession?: string; isSeeded?: boolean; origin?: 'subagent'; delegationDepth?: number; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    signal?: AbortSignal
    setup?: (agentCtx: any, agent?: any) => void | Promise<void>
    /** fork 种子(照抄原生 fork:buildForkSeed 切源会话事件前缀 + session/end-seed 标记)。 */
    seed?: Array<{ type: string; seq?: number; time?: number; data?: unknown }>
    inheritedEventCount?: number
  }): Promise<{ agent: unknown; dispose(): Promise<void> }>
}

/** 常驻辩手最小面:followup 投活 + whenIdle 等静 + cancel 中止。 */
export interface ResidentAgent {
  readonly session: {
    readonly id: string
    seq?: number
    snapshotEvents?: (...args: any[]) => readonly any[]
    events?: (...args: any[]) => readonly any[]
  }
  followup(message: any): void
  whenIdle(): Promise<void>
  cancel?: (...args: any[]) => void
  status?: unknown
  ctx?: unknown
  [key: string]: unknown
}

/** 常驻辩手对:整场存活,host 在两者之间交棒(handoff)。 */
export interface ResidentPair {
  builder: ResidentAgent
  challenger: ResidentAgent
  dispose(): Promise<void>
}

/** preset 注册表最小面:自建 parent 时挂默认 preset,子 agent 继承满血工具集。 */
export interface AgentPresetsLike {
  defaultId?: string
  mount(agentCtx: unknown, id: string): Promise<unknown>
  composeFrom?: (agentCtx: unknown, parentCtx: unknown) => string | undefined
  composedPreset?: (agentCtx: unknown) => string | undefined
}

/** 常驻辩手创建时 setup 内的最小 agentCtx 面(composition-only,不 drive)。 */
export interface ResidentSetupCtx {
  get(name: string): any
  systemPrompt: {
    section(s: { name: string; order: number; text: string }): unknown
    context(c: { name: string; order: number; text: string }): unknown
    getSectionOrder(name: string): number
    getContextOrder(name: string): number
  }
  tools: {
    restrict(filter: { allow?: string[]; deny?: string[] }): unknown
    schemas?: (scope?: unknown) => Array<{ name?: unknown }>
    guard?: (guard: (execution: { name: string }) => string | undefined) => () => void
  }
}
