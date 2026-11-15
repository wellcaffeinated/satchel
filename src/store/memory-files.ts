import { createHash } from 'node:crypto'
import type { Checkpoint, Memory, Reference, Scope } from '../types.ts'
import {
  optionalString,
  optionalStringList,
  parseFrontmatter,
  renderFrontmatter,
  requiredString,
} from './frontmatter.ts'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_PATTERN = /^[mcr]_[a-z2-7]{8}$/
const UNFENCED_FORMAT = 'markdown'
const MIN_FENCE = 3

const SCOPE_BY_NAME: Record<string, Scope> = { global: 'global', project: 'project', host: 'host' }

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

export function parseMemory(raw: string): Memory {
  const { data, body } = parseFrontmatter(raw)
  if (body === '') throw new Error('empty memory body')
  const scope = SCOPE_BY_NAME[optionalString(data, 'scope') ?? 'global']
  if (!scope) throw new Error(`invalid scope "${String(data.scope)}"`)
  const project = optionalString(data, 'project')
  const host = optionalString(data, 'host')
  if (scope === 'project' && project === undefined) throw new Error('project scope without project')
  if (scope === 'host' && host === undefined) throw new Error('host scope without host')
  const created = requiredString(data, 'created')
  const filetypes = optionalStringList(data, 'filetypes')
  const tags = optionalStringList(data, 'tags')
  return {
    id: requireId(data, 'm'),
    topic: requiredString(data, 'topic'),
    scope,
    ...(scope === 'project' && project !== undefined ? { project } : {}),
    ...(scope === 'host' && host !== undefined ? { host } : {}),
    ...(filetypes === undefined ? {} : { filetypes }),
    ...(tags === undefined ? {} : { tags }),
    created,
    updated: optionalString(data, 'updated') ?? created,
    source: optionalString(data, 'source') ?? 'unknown',
    text: body,
  }
}

export function renderMemory(memory: Memory): string {
  return renderFrontmatter({
    data: {
      id: memory.id,
      topic: memory.topic,
      scope: memory.scope,
      ...(memory.project === undefined ? {} : { project: memory.project }),
      ...(memory.host === undefined ? {} : { host: memory.host }),
      ...(memory.filetypes?.length ? { filetypes: memory.filetypes } : {}),
      ...(memory.tags?.length ? { tags: memory.tags } : {}),
      created: memory.created,
      updated: memory.updated,
      source: memory.source,
    },
    body: memory.text,
  })
}

export function parseCheckpoint(raw: string): Checkpoint {
  const { data, body } = parseFrontmatter(raw)
  return {
    id: requireId(data, 'c'),
    project: requiredString(data, 'project'),
    branch: requiredString(data, 'branch'),
    commit: optionalString(data, 'commit') ?? '',
    updated: requiredString(data, 'updated'),
    source: optionalString(data, 'source') ?? 'unknown',
    summary: body,
  }
}

export function renderCheckpoint(checkpoint: Checkpoint): string {
  return renderFrontmatter({
    data: {
      id: checkpoint.id,
      project: checkpoint.project,
      branch: checkpoint.branch,
      commit: checkpoint.commit,
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
  const scope = SCOPE_BY_NAME[optionalString(data, 'scope') ?? 'global']
  if (!scope) throw new Error(`invalid scope "${String(data.scope)}"`)
  const format = optionalString(data, 'format') ?? UNFENCED_FORMAT
  const project = optionalString(data, 'project')
  const host = optionalString(data, 'host')
  const filetypes = optionalStringList(data, 'filetypes')
  const tags = optionalStringList(data, 'tags')
  const created = requiredString(data, 'created')
  return {
    id: requireId(data, 'r'),
    topic: requiredString(data, 'topic'),
    title: requiredString(data, 'title'),
    description: optionalString(data, 'description') ?? '',
    scope,
    ...(scope === 'project' && project !== undefined ? { project } : {}),
    ...(scope === 'host' && host !== undefined ? { host } : {}),
    ...(filetypes === undefined ? {} : { filetypes }),
    ...(tags === undefined ? {} : { tags }),
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
      scope: reference.scope,
      ...(reference.project === undefined ? {} : { project: reference.project }),
      ...(reference.host === undefined ? {} : { host: reference.host }),
      ...(reference.filetypes?.length ? { filetypes: reference.filetypes } : {}),
      ...(reference.tags?.length ? { tags: reference.tags } : {}),
      format: reference.format,
      created: reference.created,
      updated: reference.updated,
      source: reference.source,
    },
    body: fencedBody(reference.content, reference.format),
  })
}
