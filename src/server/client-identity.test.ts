import { describe, expect, it } from 'vitest'
import { clientFromSessionId, sanitizeClientName, sessionIdFor } from './client-identity.ts'

describe('client identity', () => {
  it('round-trips a client name through the session id', () => {
    const sessionId = sessionIdFor('claude-code')
    expect(sessionId).toMatch(/^[\x21-\x7e]+$/)
    expect(clientFromSessionId(sessionId)).toBe('claude-code')
  })

  it('falls back to unknown', () => {
    expect(clientFromSessionId(undefined)).toBe('unknown')
    expect(clientFromSessionId('no-separator')).toBe('unknown')
    expect(clientFromSessionId('uuid.')).toBe('unknown')
  })

  it('sanitises names that would break commit messages or front matter', () => {
    expect(sanitizeClientName('evil\nname: x', 'rest')).toBe('evil-name- x')
    expect(sanitizeClientName('a'.repeat(200), 'rest').length).toBeLessThanOrEqual(64)
    expect(sanitizeClientName('', 'rest')).toBe('rest')
    expect(sanitizeClientName(undefined, 'rest')).toBe('rest')
  })
})
