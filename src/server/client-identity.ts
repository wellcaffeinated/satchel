// Who is writing: MCP clientInfo.name.
//
// 2026-07-28 clients carry clientInfo in the `_meta` envelope of every request, so the name
// is read straight from it. 2025 clients send it only on `initialize`, and the transport is
// stateless, so a later tools/call reaches a fresh server that never saw it. For them the
// initialize response carries an Mcp-Session-Id of the form `<uuid>.<base64url(name)>`;
// clients echo it on every later request and the name is read back from it. This is not
// authentication: clientInfo.name is self-reported in the first place, and auth runs before
// any of this.
import { randomUUID } from 'node:crypto'
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server'
import { CLIENT_NAME_MAX_CHARS } from '../config.ts'
import { flattenLine } from './text.ts'

export const UNKNOWN_CLIENT = 'unknown'

// Names end up in git commit messages and file front matter: keep them plain.
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9 ._@/+-]/g
const SESSION_ID_SEPARATOR = '.'

export function sanitizeClientName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const name = flattenLine(raw.replace(UNSAFE_NAME_CHARS, '-'), CLIENT_NAME_MAX_CHARS)
  return name === '' ? fallback : name
}

export function sessionIdFor(client: string): string {
  return `${randomUUID()}${SESSION_ID_SEPARATOR}${Buffer.from(client, 'utf8').toString('base64url')}`
}

export function clientFromSessionId(sessionId: string | undefined): string {
  if (!sessionId) return UNKNOWN_CLIENT
  const separator = sessionId.indexOf(SESSION_ID_SEPARATOR)
  if (separator === -1) return UNKNOWN_CLIENT
  const encoded = sessionId.slice(separator + 1, separator + 1 + CLIENT_NAME_MAX_CHARS * 2)
  return sanitizeClientName(Buffer.from(encoded, 'base64url').toString('utf8'), UNKNOWN_CLIENT)
}

/** The clientInfo name a 2026-07-28 request carries in its `_meta` envelope, if any. */
export function clientFromEnvelope(envelope: unknown): string | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  if (!(CLIENT_INFO_META_KEY in envelope)) return undefined
  const clientInfo: unknown = envelope[CLIENT_INFO_META_KEY]
  if (typeof clientInfo !== 'object' || clientInfo === null || !('name' in clientInfo)) {
    return undefined
  }
  const name = sanitizeClientName(clientInfo.name, '')
  return name === '' ? undefined : name
}
