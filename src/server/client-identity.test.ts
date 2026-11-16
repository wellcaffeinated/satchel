import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import {
  clientFromEnvelope,
  clientFromSessionId,
  sanitizeClientName,
  sessionIdFor,
} from './client-identity.ts'

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
    expect(sanitizeClientName('evil\nname: x', 'fallback')).toBe('evil-name- x')
    expect(sanitizeClientName('a'.repeat(200), 'fallback').length).toBeLessThanOrEqual(64)
    expect(sanitizeClientName('', 'fallback')).toBe('fallback')
    expect(sanitizeClientName(undefined, 'fallback')).toBe('fallback')
  })

  it('reads the client name from a 2026-07-28 request envelope', () => {
    const envelope = { [CLIENT_INFO_META_KEY]: { name: 'claude-code', version: '2' } }
    expect(clientFromEnvelope(envelope)).toBe('claude-code')
  })

  it('has no name for a missing or malformed envelope', () => {
    expect(clientFromEnvelope(undefined)).toBeUndefined()
    expect(clientFromEnvelope({})).toBeUndefined()
    expect(clientFromEnvelope({ [CLIENT_INFO_META_KEY]: 'claude-code' })).toBeUndefined()
    expect(clientFromEnvelope({ [CLIENT_INFO_META_KEY]: { name: '' } })).toBeUndefined()
  })
})
