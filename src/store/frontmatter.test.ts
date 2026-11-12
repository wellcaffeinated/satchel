import { describe, expect, it } from 'vitest'
import { parseFrontmatter, renderFrontmatter } from './frontmatter.ts'

describe('frontmatter', () => {
  it('round trips awkward strings', () => {
    const data = { a: '1234567', b: 'yes', c: 'x: y # z', d: '2026-11-12T18:04:00Z' }
    const raw = renderFrontmatter({ data, body: 'Body text.' })
    expect(parseFrontmatter(raw)).toEqual({ data, body: 'Body text.' })
  })

  it('accepts CRLF and an empty body', () => {
    expect(parseFrontmatter('---\r\nid: x\r\n---\r\n').body).toBe('')
  })

  it.each(['no frontmatter', '---\n- a\n- b\n---\nbody', '---\n: : :\n  - [\n---\nx'])(
    'rejects %j',
    (raw) => {
      expect(() => parseFrontmatter(raw)).toThrow()
    },
  )
})
