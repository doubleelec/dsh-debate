/** Resolve the real session identity supplied by a session-scoped DSH slot. */
export function resolveSessionId(sessionId: unknown): string {
  return typeof sessionId === 'string' ? sessionId : ''
}
