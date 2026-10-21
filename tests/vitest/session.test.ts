import { describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index'
import { resolveSessionId } from '../../src/client/session'

describe('session-scoped input identity', () => {
  it('registers an input-right inject that forwards the active session ID', () => {
    let inputEntryOptions: {
      inject?: (sessionId?: string) => Record<string, unknown>
    } | undefined

    const slots = {
      inject(name: string, register: () => unknown) {
        if (name === 'conversation.input.right') register()
      },
      register(options: { name: string; inject?: (sessionId?: string) => Record<string, unknown> }) {
        if (options.name === 'conversation.input.right') inputEntryOptions = options
        return () => undefined
      },
    }
    const ctx = {
      get(name: string) { return name === 'slots' ? slots : undefined },
      inject() { /* session cwd subscription is irrelevant to this test */ },
      effect() { return () => undefined },
    }

    apply(ctx as never)

    expect(inputEntryOptions?.inject).toBeTypeOf('function')
    const injected = inputEntryOptions!.inject!('session-ai-proxy-123')
    expect(resolveSessionId(injected.sessionId)).toBe('session-ai-proxy-123')
  })

  it('input-right entry keeps the enhance label(ADR-0025: 辩论→增强菜单)', () => {
    const registered: Array<{ name: string; label?: unknown }> = []
    const slots = {
      inject(name: string, register: () => unknown) {
        if (name === 'conversation.input.right') register()
      },
      register(options: { name: string; label?: unknown }) {
        if (options.name === 'conversation.input.right') registered.push(options)
        return () => undefined
      },
    }
    const ctx = {
      get(name: string) { return name === 'slots' ? slots : undefined },
      inject() { /* session cwd subscription is irrelevant to this test */ },
      effect() { return () => undefined },
    }

    apply(ctx as never)

    expect(registered.length).toBe(1)
    const label = registered[0].label
    const text = typeof label === 'function' ? String(label()) : String(label ?? '')
    // 增强菜单:不再叫"辩论",两项(辩论/多仓任务)走 overlay 面板显式按钮,不借原生发送键。
    expect(text).toContain('增强')
    expect(text).not.toMatch(/^⚔ 双视角辩论$/)
  })

  it('does not turn missing or malformed identity into a session ID', () => {
    expect(resolveSessionId(undefined)).toBe('')
    expect(resolveSessionId(null)).toBe('')
    expect(resolveSessionId({ id: 'session-ai-proxy-123' })).toBe('')
  })
})
