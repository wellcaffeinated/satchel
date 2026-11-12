import { createHash } from 'node:crypto'
import type { Checkpoint, Memory, Scope } from '../types.ts'
import {
  optionalString,
  parseFrontmatter,
  renderFrontmatter,
  requiredString,
} from './frontmatter.ts'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_PATTERN = /^[mc]_[a-z2-7]{8}$/

const SCOPE_BY_NAME: Record<string, Scope> = { global: 'global', project: 'project', host: 'host' }

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function randomId(prefix: 'm' | 'c', randomBytes: Uint8Array): string {
  const chars = [...randomBytes.slice(0, 8)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
  return `${prefix}_${chars.join('')}`
}

function requireId(data: Record<string, unknown>, prefix: 'm' | 'c'): string {
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
  return {
    id: requireId(data, 'm'),
    topic: requiredString(data, 'topic'),
    scope,
    ...(scope === 'project' && project !== undefined ? { project } : {}),
    ...(scope === 'host' && host !== undefined ? { host } : {}),
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
