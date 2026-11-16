import {
  ABOUT_MAX_CHARS,
  ABOUT_PATTERN,
  CHECKPOINT_SUMMARY_MAX_CHARS,
  CLIENT_NAME_MAX_CHARS,
  DEFAULT_MEMORY_KIND,
  DEFAULT_MEMORY_ORIGIN,
  FILETYPE_PATTERN,
  LABEL_MAX_CHARS,
  LABELS_MAX_COUNT,
  MEMORY_KINDS,
  MEMORY_MAX_CHARS,
  MEMORY_ORIGINS,
  REFERENCE_DESCRIPTION_MAX_CHARS,
  REFERENCE_FORMAT_PATTERN,
  REFERENCE_MAX_CHARS,
  REFERENCE_TITLE_MAX_CHARS,
  TAG_PATTERN,
  TOPIC_NAME_MAX_CHARS,
  TOPIC_NAME_PATTERN,
  TRIGGER_MAX_CHARS,
} from '../config.ts'
import {
  type CheckpointInput,
  type MemorizeInput,
  type Memory,
  type MemoryKind,
  type MemoryOrigin,
  type Reference,
  SatchelError,
  type SaveReferenceInput,
  type Scope,
} from '../types.ts'
import { normaliseTime } from './time.ts'

const IDENTIFIER_MAX_CHARS = 200
const COMMIT_MAX_CHARS = 64
const UNKNOWN_CLIENT = 'unknown'

export interface ValidMemoryFields {
  text: string
  topic: string
  kind: MemoryKind
  origin: MemoryOrigin
  date?: string
  expires?: string
  about?: string[]
  scope: Scope
  context?: string
  host?: string
  filetypes?: string[]
  tags?: string[]
  topicTrigger?: string
}

export interface ValidReferenceFields {
  title: string
  description: string
  content: string
  format: string
  topic: string
  scope: Scope
  context?: string
  host?: string
  filetypes?: string[]
  tags?: string[]
  about?: string[]
  expires?: string
  topicTrigger?: string
}

export interface ValidCheckpointFields {
  context: string
  thread: string
  commit?: string // undefined keeps the stored commit; empty clears it
  summary?: string
}

/** Collapses whitespace and control characters; safe for commit messages and logs. */
export function cleanClientName(value: string): string {
  const cleaned = value
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, CLIENT_NAME_MAX_CHARS)
  return cleaned === '' ? UNKNOWN_CLIENT : cleaned
}

function requireText(value: string | undefined, name: string, maxChars: number): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') throw new SatchelError('invalid', `${name} must not be empty.`)
  if (trimmed.length > maxChars) {
    throw new SatchelError(
      'too_long',
      `${name} is ${trimmed.length} characters; the limit is ${maxChars}.`,
    )
  }
  return trimmed
}

export function validateTopicName(topic: string): string {
  const name = topic.trim()
  if (name.length > TOPIC_NAME_MAX_CHARS) {
    throw new SatchelError(
      'too_long',
      `Topic name is ${name.length} characters; the limit is ${TOPIC_NAME_MAX_CHARS}.`,
    )
  }
  if (!TOPIC_NAME_PATTERN.test(name)) {
    throw new SatchelError(
      'invalid',
      'Topic names are lowercase kebab-case, for example "svelte" or "home-server".',
    )
  }
  return name
}

export function validateTrigger(trigger: string): string {
  return requireText(trigger.replace(/\s+/g, ' '), 'topic_trigger', TRIGGER_MAX_CHARS)
}

type Scoped = Pick<MemorizeInput, 'context' | 'host'>

const SCOPE_FIELDS: Record<Scope, (input: Scoped) => { context?: string; host?: string }> = {
  global: () => ({}),
  context: (input) => ({
    context: requireText(
      input.context,
      'context (required for context scope)',
      IDENTIFIER_MAX_CHARS,
    ),
  }),
  host: (input) => ({
    host: requireText(input.host, 'host (required for host scope)', IDENTIFIER_MAX_CHARS),
  }),
}

function scopeFields(input: { scope?: Scope } & Scoped) {
  const scope = input.scope ?? 'global'
  const fields = SCOPE_FIELDS[scope]
  if (!fields) throw new SatchelError('invalid', `Unknown scope "${String(scope)}".`)
  return { scope, ...fields(input) }
}

const LABEL_RULES = {
  filetypes: {
    pattern: FILETYPE_PATTERN,
    maxChars: LABEL_MAX_CHARS,
    normalise: (value: string) => value.trim().toLowerCase().replace(/^\./, ''),
    example: 'file extensions without the dot, such as "ts" or "py"',
  },
  tags: {
    pattern: TAG_PATTERN,
    maxChars: LABEL_MAX_CHARS,
    normalise: (value: string) => value.trim().toLowerCase(),
    example: 'lowercase kebab-case labels, such as "code" or "rxjs"',
  },
  about: {
    pattern: ABOUT_PATTERN,
    maxChars: ABOUT_MAX_CHARS,
    normalise: (value: string) => value.trim().toLowerCase(),
    example: 'lowercase kebab-case names, optionally typed, such as "alice" or "person:alice"',
  },
} satisfies Record<
  'filetypes' | 'tags' | 'about',
  { pattern: RegExp; maxChars: number; normalise: (v: string) => string; example: string }
>

/** Normalised, de-duplicated labels, or undefined when none. Throws on bad values. */
export function validateLabels(
  kind: keyof typeof LABEL_RULES,
  values: string[] | undefined,
): string[] | undefined {
  if (values === undefined) return undefined
  const rule = LABEL_RULES[kind]
  const labels = [...new Set(values.map(rule.normalise).filter((value) => value !== ''))]
  if (labels.length > LABELS_MAX_COUNT) {
    throw new SatchelError('invalid', `At most ${LABELS_MAX_COUNT} ${kind}.`)
  }
  const bad = labels.find((label) => label.length > rule.maxChars || !rule.pattern.test(label))
  if (bad !== undefined) {
    throw new SatchelError('invalid', `Invalid ${kind} value "${bad}": use ${rule.example}.`)
  }
  return labels.length === 0 ? undefined : labels
}

function labelFields(input: { filetypes?: string[]; tags?: string[]; about?: string[] }) {
  const filetypes = validateLabels('filetypes', input.filetypes)
  const tags = validateLabels('tags', input.tags)
  const about = validateLabels('about', input.about)
  return {
    ...(filetypes === undefined ? {} : { filetypes }),
    ...(tags === undefined ? {} : { tags }),
    ...(about === undefined ? {} : { about }),
  }
}

/** A day or timestamp, normalised; null and undefined both mean "none". */
function timeField(value: string | null | undefined, name: string): string | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined
  const time = normaliseTime(value)
  if (time === undefined) {
    throw new SatchelError(
      'invalid',
      `${name} "${value.trim().slice(0, 40)}" is not a date: use YYYY-MM-DD or an ISO 8601 timestamp.`,
    )
  }
  return time
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
  fallback: T,
): T {
  if (value === undefined) return fallback
  const found = allowed.find((candidate) => candidate === value)
  if (found === undefined) {
    throw new SatchelError('invalid', `${name} must be one of ${allowed.join(', ')}.`)
  }
  return found
}

/** The entries of a patch that were given at all; `null` counts, it clears a field. */
function given<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}

/** A stored memory as the input that would recreate it: the base a patch applies to. */
function memoryAsInput(memory: Memory): Omit<MemorizeInput, 'source'> {
  return {
    text: memory.text,
    topic: memory.topic,
    kind: memory.kind,
    origin: memory.origin,
    date: memory.date,
    expires: memory.expires,
    about: memory.about,
    scope: memory.scope,
    context: memory.context,
    host: memory.host,
    filetypes: memory.filetypes,
    tags: memory.tags,
  }
}

/**
 * The fields a save ends up with. With `existing`, the input is a patch: fields it leaves
 * out keep their stored values, and the merged result is checked as a whole.
 */
export function validateMemorize(input: MemorizeInput, existing?: Memory): ValidMemoryFields {
  const merged = existing ? { ...memoryAsInput(existing), ...given(input) } : input
  const kind = oneOf(merged.kind, MEMORY_KINDS, 'kind', DEFAULT_MEMORY_KIND)
  const date = timeField(merged.date, 'date')
  if (kind === 'event' && date === undefined) {
    throw new SatchelError('invalid', 'kind "event" needs `date` (YYYY-MM-DD).')
  }
  const expires = timeField(merged.expires, 'expires')
  return {
    text: requireText(merged.text, 'text', MEMORY_MAX_CHARS),
    topic: validateTopicName(merged.topic ?? ''),
    kind,
    origin: oneOf(merged.origin, MEMORY_ORIGINS, 'origin', DEFAULT_MEMORY_ORIGIN),
    ...(date === undefined ? {} : { date }),
    ...(expires === undefined ? {} : { expires }),
    ...scopeFields(merged),
    ...labelFields(merged),
    ...(merged.topicTrigger === undefined
      ? {}
      : { topicTrigger: validateTrigger(merged.topicTrigger) }),
  }
}

const DEFAULT_REFERENCE_FORMAT = 'markdown'

function validateFormat(format: string | undefined): string {
  const value = format?.trim().toLowerCase() || DEFAULT_REFERENCE_FORMAT
  if (!REFERENCE_FORMAT_PATTERN.test(value)) {
    throw new SatchelError(
      'invalid',
      `format "${value}" should be a language name such as "jsonc".`,
    )
  }
  return value
}

function validateContent(content: string | undefined): string {
  if (content === undefined || content.trim() === '') {
    throw new SatchelError('invalid', 'content must not be empty.')
  }
  if (content.length > REFERENCE_MAX_CHARS) {
    throw new SatchelError(
      'too_long',
      `content is ${content.length} characters; the limit is ${REFERENCE_MAX_CHARS}.`,
    )
  }
  return content.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '')
}

function referenceAsInput(reference: Reference): Omit<SaveReferenceInput, 'source'> {
  return {
    title: reference.title,
    description: reference.description,
    content: reference.content,
    format: reference.format,
    topic: reference.topic,
    scope: reference.scope,
    context: reference.context,
    host: reference.host,
    filetypes: reference.filetypes,
    tags: reference.tags,
    about: reference.about,
    expires: reference.expires,
  }
}

export function validateReference(
  input: SaveReferenceInput,
  existing?: Reference,
): ValidReferenceFields {
  const merged = existing ? { ...referenceAsInput(existing), ...given(input) } : input
  const expires = timeField(merged.expires, 'expires')
  return {
    title: requireText(merged.title?.replace(/\s+/g, ' '), 'title', REFERENCE_TITLE_MAX_CHARS),
    description: requireText(
      merged.description?.replace(/\s+/g, ' '),
      'description',
      REFERENCE_DESCRIPTION_MAX_CHARS,
    ),
    content: validateContent(merged.content),
    format: validateFormat(merged.format),
    topic: validateTopicName(merged.topic ?? ''),
    ...scopeFields(merged),
    ...labelFields(merged),
    ...(expires === undefined ? {} : { expires }),
    ...(merged.topicTrigger === undefined
      ? {}
      : { topicTrigger: validateTrigger(merged.topicTrigger) }),
  }
}

function optionalText(
  value: string | undefined,
  name: string,
  maxChars: number,
): string | undefined {
  if (value === undefined) return undefined
  return value.trim() === '' ? '' : requireText(value, name, maxChars)
}

export function validateCheckpoint(input: CheckpointInput): ValidCheckpointFields {
  const commit = optionalText(input.commit, 'commit', COMMIT_MAX_CHARS)
  const summary = optionalText(input.summary, 'summary', CHECKPOINT_SUMMARY_MAX_CHARS)
  return {
    context: requireText(input.context, 'context', IDENTIFIER_MAX_CHARS),
    thread: requireText(input.thread, 'thread', IDENTIFIER_MAX_CHARS),
    ...(commit === undefined ? {} : { commit }),
    ...(summary === undefined ? {} : { summary }),
  }
}
