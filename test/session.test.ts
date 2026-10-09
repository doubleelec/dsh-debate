import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index'
import { resolveSessionId } from '../src/client/session'

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

  it('does not turn missing or malformed identity into a session ID', () => {
    expect(resolveSessionId(undefined)).toBe('')
    expect(resolveSessionId(null)).toBe('')
    expect(resolveSessionId({ id: 'session-ai-proxy-123' })).toBe('')
  })
})
