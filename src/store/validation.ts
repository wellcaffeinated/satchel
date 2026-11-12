import {
  CLIENT_NAME_MAX_CHARS,
  MEMORY_MAX_CHARS,
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  TOPIC_NAME_MAX_CHARS,
  TOPIC_NAME_PATTERN,
  TRIGGER_MAX_CHARS,
} from '../config.ts'
import { type CheckpointInput, type RememberInput, SatchelError, type Scope } from '../types.ts'

const IDENTIFIER_MAX_CHARS = 200
const COMMIT_MAX_CHARS = 64
const CHECKPOINT_SUMMARY_MAX_CHARS = MEMORY_MAX_CHARS * 2
const UNKNOWN_CLIENT = 'unknown'

export interface ValidMemoryFields {
  text: string
  topic: string
  scope: Scope
  project?: string
  host?: string
  topicTrigger?: string
}

export interface ValidCheckpointFields {
  project: string
  branch: string
  commit: string
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

const SCOPE_FIELDS: Record<Scope, (input: RememberInput) => { project?: string; host?: string }> = {
  global: () => ({}),
  project: (input) => ({
    project: requireText(
      input.project,
      'project (required for project scope)',
      IDENTIFIER_MAX_CHARS,
    ),
  }),
  host: (input) => ({
    host: requireText(input.host, 'host (required for host scope)', IDENTIFIER_MAX_CHARS),
  }),
}

export function validateRemember(input: RememberInput): ValidMemoryFields {
  const scope = input.scope ?? 'global'
  const scopeFields = SCOPE_FIELDS[scope]
  if (!scopeFields) throw new SatchelError('invalid', `Unknown scope "${String(scope)}".`)
  return {
    text: requireText(input.text, 'text', MEMORY_MAX_CHARS),
    topic: validateTopicName(input.topic),
    scope,
    ...scopeFields(input),
    ...(input.topicTrigger === undefined
      ? {}
      : { topicTrigger: validateTrigger(input.topicTrigger) }),
  }
}

export function validateCheckpoint(input: CheckpointInput): ValidCheckpointFields {
  return {
    project: requireText(input.project, 'project', IDENTIFIER_MAX_CHARS),
    branch: requireText(input.branch, 'branch', IDENTIFIER_MAX_CHARS),
    commit: requireText(input.commit, 'commit', COMMIT_MAX_CHARS),
    ...(input.summary === undefined
      ? {}
      : {
          summary:
            input.summary.trim() === ''
              ? ''
              : requireText(input.summary, 'summary', CHECKPOINT_SUMMARY_MAX_CHARS),
        }),
  }
}

export function clampRecallLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECALL_DEFAULT_LIMIT
  return Math.min(RECALL_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}
