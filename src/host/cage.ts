/**
 * src/host/cage.ts — 工具笼(S16 白名单:只读论证员)。
 *
 * 深模块:小接口(名单 + 核对 + guard + ask),大实现(交集核对/超时 ask/实报)。
 * S27 从 src/index.ts 摘出;纯函数部分已在 vitest 面上,askSubagent 需 IO。
 * 名单依据:2026-10-20 线上 scope 实测(standard preset,31 个全局工具)。
 */
import type { ParentAgent, SubagentsLike, TextContentBlock } from './types'

/**
 * 辩论子 agent 工具笼(S16 白名单:只读论证员):
 * - 辩手(建构/挑战):读文件找证据 + 联网查证,六项。
 * - 制图员:只读实录,不参辩,三项(读 + 找文件,不联网)。
 * - 白名单语义(工具注册表文档):allow 只留点名的,后来出现的新工具一律排除;
 *   deny 则相反,新工具默认放行——只读角色必须用 allow,否则每加一个新工具都是一次敞口。
 * - allow 只能点全局名:scope-local(如 preset 层的 `subagent`)列了就 unknown 抛错
 *   (deny 同理);这类名字走执行期 guard 拦,不进名单。
 */
export const DEBATER_TOOL_ALLOW = ['read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search']
export const SYNTH_TOOL_ALLOW = ['read', 'read_image', 'glob']

/** 角色取名单:辩手六项,制图员三项(两处挂载点同源,不各写一份)。 */
export function toolAllowFor(role: 'builder' | 'challenger' | 'synthesizer'): string[] {
  return role === 'synthesizer' ? [...SYNTH_TOOL_ALLOW] : [...DEBATER_TOOL_ALLOW]
}

/**
 * 启动核对(S16):种子名单与宿主实际工具表取交集,失效名剔掉并留痕。
 * - 交集源 = host 侧 `schemas(parent)` 的全局视图。
 * - 取不到实际表(undefined,接口不存在/抛错) → 按种子先发、标 unverified,
 *   让系统自己的 unknown 校验报错(挑战者终轮结论:不把可选接口当启动硬依赖)。
 * - 交集为空 → 显式抛 `empty-allow`,不无笼裸奔(建构者终轮:终态定为直接失败)。
 * 纯函数,可单测;IO(读 schemas)在调用方。
 */
export function resolveToolAllow(seed: string[], visible: string[] | undefined): { allow: string[]; dropped: string[]; unverified: boolean } {
  if (visible === undefined) return { allow: [...seed], dropped: [], unverified: true }
  const set = new Set(visible)
  const allow = seed.filter((n) => set.has(n))
  const dropped = seed.filter((n) => !set.has(n))
  if (allow.length === 0) throw new Error(`empty-allow:种子名单 ${seed.join(',')} 与宿主实际工具表无交集(实际:${visible.join(',')}),不无笼裸奔`)
  return { allow, dropped, unverified: false }
}

/**
 * 从 schemas 原始形状里抽全局工具名(非字符串一律丢掉,不猜不编)。
 * schemas 条目形状 `{ name?: unknown }`,与 debug-agent 路由同源。
 */
export function visibleNamesOf(all: Array<{ name?: unknown }> | undefined): string[] {
  if (!Array.isArray(all)) return []
  return all.map((t) => t.name).filter((n): n is string => typeof n === 'string')
}

/**
 * 笼标签(S16):生效笼型并入已启动进度行,会话可见,不只写日志。
 * 辩论结论:开局那一行挂笼,不必每轮刷新。
 */
export function cageLabel(allow: string[], dropped: string[], unverified = false): string {
  const base = `工具笼·白名单${allow.length}项(${allow.join('/')})`
  if (unverified) return `${base},实际表未核对(按种子先发)`
  if (dropped.length > 0) return `${base},剔除失效${dropped.length}项(${dropped.join('/')})`
  return base
}

/** scope-local 工具名(allow/restrict 都拦不住,filter 只影响全局层):执行期 guard 拦。 */
const SCOPED_TOOL_GUARD_DENY = ['subagent']

/**
 * 执行期 guard(S16):拦 scope-local 工具(如 preset 层的 `subagent`)。
 * 白名单与 restrict 只动全局层,scoped 注册随后合并、不受影响(工具注册表文档),
 * 所以这类名字必须在执行时再拦一道。同步函数,返串即拒、返 undefined 即放行。
 * one-shot 链路无挂载点(子 agent 由 subagents.start 内部组装),只挂常驻 setup。
 */
export function scopedToolGuard(execution: { name: string }): string | undefined {
  if (SCOPED_TOOL_GUARD_DENY.includes(execution.name)) {
    return `se-guard:subagent 类 scope-local 工具不许辩手调用(${execution.name})`
  }
  return undefined
}

/** 文本块提取:子 agent 输出的 assistant 文本。容忍 unknown(交棒结论提取与 ask 结果共用)。 */
export function textOf(blocks: Array<{ type?: unknown; text?: unknown }> | unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

/** 一次性子 agent 单步超时:6 分钟。子 agent hang 住(等人点/大海捞针)时直接失败,不无限卡轮次。 */
const STEP_TIMEOUT_MS = 6 * 60 * 1000

/** 常驻辩手轮次卡死阈值:多久没有任何新事件才算卡住(干活久不算错,见 turnVerdict)。 */
export const STEP_STALL_MS = 4 * 60 * 1000

/** 常驻辩手单轮硬顶:再久也不能无限等(有进度也砍),兜住"永不 hang"。 */
export const STEP_HARD_CAP_MS = 20 * 60 * 1000

/** 常驻辩手轮次进度采样间隔。 */
export const PROGRESS_POLL_MS = 10 * 1000

/**
 * 常驻轮次是否该中断(纯判定,便于单测):
 * idleMs=距上次有新事件的时长,totalMs=本 turn 总时长。
 * 先看硬顶(有进度也砍),再看卡死(无新事件)。两者都够不到才继续等。
 */
export function turnVerdict(idleMs: number, totalMs: number): 'ok' | 'stalled' | 'hard-cap' {
  if (totalMs >= STEP_HARD_CAP_MS) return 'hard-cap'
  if (idleMs >= STEP_STALL_MS) return 'stalled'
  return 'ok'
}

/** 起一次 one-shot 子 agent 并取文本(带工具笼 + 单步超时 + 实报原因)。 */
export async function askSubagent(
  subagents: SubagentsLike,
  parent: ParentAgent,
  sessionId: string,
  role: 'builder' | 'challenger' | 'synthesizer',
  prompt: string,
  route: { provider: string; model: string },
  signal: AbortSignal,
): Promise<string> {
  const timeout = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => {
    timeoutFired = true
    timeout.abort(new Error(`subagent-${role}:timeout(${STEP_TIMEOUT_MS / 60000}min)`))
  }, STEP_TIMEOUT_MS)
  const onAbort = (): void => timeout.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    // S16 白名单:one-shot 无 schemas 核对挂载点(spawn 内部组装,父进程表未必是子表),
    // 按种子先发、交系统 unknown 校验(挑战者终轮结论);scope-local 敞口见笼注释。
    const run = await subagents.start('spawn', {
      parent,
      prompt: [{ type: 'text', text: prompt } as TextContentBlock],
      label: `se-${sessionId}-${role}`,
      signal: timeout.signal,
      agentOptions: { provider: route.provider, model: route.model },
      toolFilter: { allow: toolAllowFor(role) },
    })
    try {
      let result: { output: TextContentBlock[]; stopReason: string }
      try {
        result = await run.result
      } catch (e) {
        // 基础设施fault(result Promise 本身 reject):外层停了归 stopped,超时归超时。
        if (signal.aborted) throw new Error('aborted')
        if (timeoutFired) throw new Error(`subagent-${role}:timeout(${STEP_TIMEOUT_MS / 60000}min,写超时,已中止)`)
        throw e instanceof Error ? e : new Error(String(e))
      }
      if (result.stopReason === 'completed') return textOf(result.output)
      // stopReason 非 completed:先分清是谁杀的,再实报(之前一律报 aborted,超时原因被吞)。
      if (signal.aborted) throw new Error('aborted')
      if (timeoutFired) throw new Error(`subagent-${role}:timeout(${STEP_TIMEOUT_MS / 60000}min,写超时,已中止)`)
      throw new Error(`subagent-${role}:${result.stopReason}`)
    } finally {
      await run.dispose()
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
