import { createHash } from 'node:crypto'
import {
  DEFAULT_MEMORY_KIND,
  DEFAULT_MEMORY_ORIGIN,
  DEFAULT_THREAD,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
} from '../config.ts'
import type { Checkpoint, Memory, MemoryKind, MemoryOrigin, Reference, Scope } from '../types.ts'
import {
  optionalString,
  optionalStringList,
  parseFrontmatter,
  renderFrontmatter,
  requiredString,
} from './frontmatter.ts'
import { normaliseTime } from './time.ts'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_PATTERN = /^[mcr]_[a-z2-7]{8}$/
const UNFENCED_FORMAT = 'markdown'
const MIN_FENCE = 3

const SCOPE_BY_NAME: Record<string, Scope> = { global: 'global', context: 'context', host: 'host' }
const KIND_BY_NAME = new Map<string, MemoryKind>(MEMORY_KINDS.map((kind) => [kind, kind]))
const ORIGIN_BY_NAME = new Map<string, MemoryOrigin>(
  MEMORY_ORIGINS.map((origin) => [origin, origin]),
)

/**
 * The rule a memory states: its first paragraph. Embeddings and the similar-memory check
 * use only this, so code examples do not make unrelated rules look alike.
 */
export function leadParagraph(text: string): string {
  return text.trim().split(/\n[ \t]*\n/, 1)[0] ?? ''
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function randomId(prefix: 'm' | 'c' | 'r', randomBytes: Uint8Array): string {
  const chars = [...randomBytes.slice(0, 8)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
  return `${prefix}_${chars.join('')}`
}

function requireId(data: Record<string, unknown>, prefix: 'm' | 'c' | 'r'): string {
  const id = requiredString(data, 'id')
  if (!isValidId(id) || !id.startsWith(`${prefix}_`)) throw new Error(`invalid id "${id}"`)
  return id
}

function parseScope(data: Record<string, unknown>): {
  scope: Scope
  context?: string
  host?: string
} {
  const scope = SCOPE_BY_NAME[optionalString(data, 'scope') ?? 'global']
  if (!scope) throw new Error(`invalid scope "${String(data.scope)}"`)
  const context = optionalString(data, 'context')
  const host = optionalString(data, 'host')
  if (scope === 'context' && context === undefined) throw new Error('context scope without context')
  if (scope === 'host' && host === undefined) throw new Error('host scope without host')
  return {
    scope,
    ...(scope === 'context' && context !== undefined ? { context } : {}),
    ...(scope === 'host' && host !== undefined ? { host } : {}),
  }
}

/** The three label lists, present only when non-empty. */
function parseLabels(data: Record<string, unknown>) {
  const filetypes = optionalStringList(data, 'filetypes')
  const tags = optionalStringList(data, 'tags')
  const about = optionalStringList(data, 'about')
  return {
    ...(filetypes === undefined ? {} : { filetypes }),
    ...(tags === undefined ? {} : { tags }),
    ...(about === undefined ? {} : { about }),
  }
}

/** A date field, normalised; a value that is not a date makes the file malformed. */
function parseTime(data: Record<string, unknown>, key: string): string | undefined {
  const raw = optionalString(data, key)
  if (raw === undefined) return undefined
  const time = normaliseTime(raw)
  if (time === undefined) throw new Error(`"${key}" is not a date: ${raw}`)
  return time
}

function parseKind(data: Record<string, unknown>): MemoryKind {
  const raw = optionalString(data, 'kind') ?? DEFAULT_MEMORY_KIND
  const kind = KIND_BY_NAME.get(raw)
  if (!kind) throw new Error(`invalid kind "${raw}"`)
  return kind
}

function parseOrigin(data: Record<string, unknown>): MemoryOrigin {
  const raw = optionalString(data, 'origin') ?? DEFAULT_MEMORY_ORIGIN
  const origin = ORIGIN_BY_NAME.get(raw)
  if (!origin) throw new Error(`invalid origin "${raw}"`)
  return origin
}

export function parseMemory(raw: string): Memory {
  const { data, body } = parseFrontmatter(raw)
  if (body === '') throw new Error('empty memory body')
  const created = requiredString(data, 'created')
  const kind = parseKind(data)
  const date = parseTime(data, 'date')
  const expires = parseTime(data, 'expires')
  if (kind === 'event' && date === undefined) throw new Error('event without a date')
  return {
    id: requireId(data, 'm'),
    topic: requiredString(data, 'topic'),
    kind,
    origin: parseOrigin(data),
    ...(date === undefined ? {} : { date }),
    ...(expires === undefined ? {} : { expires }),
    ...parseScope(data),
    ...parseLabels(data),
    created,
    updated: optionalString(data, 'updated') ?? created,
    source: optionalString(data, 'source') ?? 'unknown',
    text: body,
  }
}

function scopeData(scoped: { scope: Scope; context?: string; host?: string }) {
  return {
    scope: scoped.scope,
    ...(scoped.context === undefined ? {} : { context: scoped.context }),
    ...(scoped.host === undefined ? {} : { host: scoped.host }),
  }
}

function labelData(labelled: { filetypes?: string[]; tags?: string[]; about?: string[] }) {
  return {
    ...(labelled.about?.length ? { about: labelled.about } : {}),
    ...(labelled.filetypes?.length ? { filetypes: labelled.filetypes } : {}),
    ...(labelled.tags?.length ? { tags: labelled.tags } : {}),
  }
}

export function renderMemory(memory: Memory): string {
  return renderFrontmatter({
    data: {
      id: memory.id,
      topic: memory.topic,
      kind: memory.kind,
      origin: memory.origin,
      ...(memory.date === undefined ? {} : { date: memory.date }),
      ...(memory.expires === undefined ? {} : { expires: memory.expires }),
      ...scopeData(memory),
      ...labelData(memory),
      created: memory.created,
      updated: memory.updated,
      source: memory.source,
    },
    body: memory.text,
  })
}

export function parseCheckpoint(raw: string): Checkpoint {
  const { data, body } = parseFrontmatter(raw)
  const commit = optionalString(data, 'commit')
  return {
    id: requireId(data, 'c'),
    context: requiredString(data, 'context'),
    thread: optionalString(data, 'thread') ?? DEFAULT_THREAD,
    ...(commit === undefined ? {} : { commit }),
    updated: requiredString(data, 'updated'),
    source: optionalString(data, 'source') ?? 'unknown',
    summary: body,
  }
}

export function renderCheckpoint(checkpoint: Checkpoint): string {
  return renderFrontmatter({
    data: {
      id: checkpoint.id,
      context: checkpoint.context,
      thread: checkpoint.thread,
      ...(checkpoint.commit === undefined ? {} : { commit: checkpoint.commit }),
      updated: checkpoint.updated,
      source: checkpoint.source,
    },
    body: checkpoint.summary,
  })
}

/** A fence longer than any backtick run in the content, so the content never closes it. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(MIN_FENCE, longest + 1))
}

function fencedBody(content: string, format: string): string {
  if (format === UNFENCED_FORMAT) return content
  const fence = fenceFor(content)
  return `${fence}${format}\n${content}\n${fence}`
}

/** The content inside the one fenced block a reference body holds; the whole body otherwise. */
function unfencedContent(body: string, format: string): string {
  if (format === UNFENCED_FORMAT) return body
  const match = /^(`{3,})[^\n`]*\n([\s\S]*?)\n\1[ \t]*$/.exec(body)
  return match?.[2] ?? body
}

export function parseReference(raw: string): Reference {
  const { data, body } = parseFrontmatter(raw)
  const format = optionalString(data, 'format') ?? UNFENCED_FORMAT
  const created = requiredString(data, 'created')
  const expires = parseTime(data, 'expires')
  return {
    id: requireId(data, 'r'),
    topic: requiredString(data, 'topic'),
    title: requiredString(data, 'title'),
    description: optionalString(data, 'description') ?? '',
    ...parseScope(data),
    ...parseLabels(data),
    ...(expires === undefined ? {} : { expires }),
    format,
    created,
    updated: optionalString(data, 'updated') ?? created,
    source: optionalString(data, 'source') ?? 'unknown',
    content: unfencedContent(body, format),
  }
}

export function renderReference(reference: Reference): string {
  return renderFrontmatter({
    data: {
      id: reference.id,
      topic: reference.topic,
      title: reference.title,
      description: reference.description,
      ...scopeData(reference),
      ...labelData(reference),
      ...(reference.expires === undefined ? {} : { expires: reference.expires }),
      format: reference.format,
      created: reference.created,
      updated: reference.updated,
      source: reference.source,
    },
    body: fencedBody(reference.content, reference.format),
  })
}
