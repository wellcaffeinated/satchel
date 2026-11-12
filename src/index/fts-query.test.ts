import { describe, expect, it } from 'vitest'
import { tokenize, toMatchQuery } from './fts-query.ts'

describe('toMatchQuery', () => {
  it('quotes and ORs tokens', () => {
    expect(toMatchQuery('svelte bindings')).toBe('"svelte" OR "bindings"')
  })

  it('splits hyphens and strips operators and punctuation', () => {
    expect(toMatchQuery('foo-bar "AND" NEAR( * col:x')).toBe(
      '"foo" OR "bar" OR "near" OR "col" OR "x"',
    )
  })

  it('drops stopwords unless only stopwords remain', () => {
    expect(toMatchQuery('how do I keep the bread')).toBe('"keep" OR "bread"')
    expect(toMatchQuery('what is the')).toBe('"what" OR "is" OR "the"')
  })

  it('is undefined when nothing is searchable', () => {
    expect(toMatchQuery('"" -- ()')).toBeUndefined()
  })

  it('caps the number of terms', () => {
    const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')
    expect(tokenize(text)).toHaveLength(32)
  })
})
