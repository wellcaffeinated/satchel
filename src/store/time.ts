// Dates on memories: a day ("2026-12-03") or an ISO 8601 timestamp. See docs/design.md.

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const MILLIS = /\.\d{3}Z$/

/**
 * The value as stored: a day stays a day, a timestamp becomes UTC without milliseconds.
 * Undefined when the value is not a date at all.
 */
export function normaliseTime(value: string): string | undefined {
  const trimmed = value.trim()
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return undefined
  if (DAY.test(trimmed)) return trimmed
  if (!TIMESTAMP.test(trimmed)) return undefined
  return parsed.toISOString().replace(MILLIS, 'Z')
}

/** The instant a stored value names, as a sortable UTC timestamp; a day is its midnight UTC. */
export function toInstant(value: string): string {
  return new Date(value).toISOString().replace(MILLIS, 'Z')
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(MILLIS, 'Z')
}
