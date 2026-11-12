import { createHash } from 'node:crypto'

const BODY_SLUG_WORDS = 6
const BODY_SLUG_MAX_CHARS = 40
const SEGMENT_MAX_CHARS = 80
const SEGMENT_HASH_CHARS = 6

/** Filename slug from the first words of a memory body. */
export function slugifyBody(body: string): string {
  const words = body
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, BODY_SLUG_WORDS)
  const slug = (words ?? []).join('-').slice(0, BODY_SLUG_MAX_CHARS).replace(/-+$/, '')
  return slug === '' ? 'memory' : slug
}

/**
 * One path segment derived from free-form text. Never contains a separator, never starts
 * with a dot, so it cannot leave its directory. Any text that had to be altered gets a hash
 * suffix so distinct inputs ("feat/a" and "feat-a") never share a file.
 */
export function safePathSegment(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, SEGMENT_MAX_CHARS)
  if (slug === value) return slug
  const hash = createHash('sha1').update(value).digest('hex').slice(0, SEGMENT_HASH_CHARS)
  return `${slug === '' ? 'x' : slug}-${hash}`
}
