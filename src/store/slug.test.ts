import { describe, expect, it } from 'vitest'
import { safePathSegment, slugifyBody } from './slug.ts'

describe('slugifyBody', () => {
  it('uses the first words', () => {
    expect(slugifyBody('Function bindings in Svelte 5 write to the getter')).toBe(
      'function-bindings-in-svelte-5-write',
    )
  })

  it('falls back when there are no words', () => {
    expect(slugifyBody('?!')).toBe('memory')
  })
})

describe('safePathSegment', () => {
  it('keeps plain names unchanged', () => {
    expect(safePathSegment('main')).toBe('main')
    expect(safePathSegment('github.com-owner-repo')).toBe('github.com-owner-repo')
  })

  it.each(['../../x', '..', '.', 'feat/a/b', '/etc/passwd', 'a\\b', '.git', '\0'])(
    'contains %j inside one segment',
    (value) => {
      const segment = safePathSegment(value)
      expect(segment).not.toMatch(/[/\\\0]/)
      expect(segment.startsWith('.')).toBe(false)
      expect(segment).not.toBe('')
    },
  )

  it('keeps lossy inputs distinct', () => {
    expect(safePathSegment('feat/a')).not.toBe(safePathSegment('feat-a'))
  })
})
