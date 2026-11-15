// Who is writing: MCP clientInfo.name.
//
// The MCP transport is stateless, so a tools/call request reaches a fresh server that never
// saw `initialize` and has no clientInfo. To keep the writer's name anyway, the initialize
// response carries an Mcp-Session-Id of the form `<uuid>.<base64url(name)>`; clients echo it
// on every later request and the name is read back from it. This is not authentication:
// clientInfo.name is self-reported in the first place, and auth runs before any of this.
import { randomUUID } from 'node:crypto'
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
