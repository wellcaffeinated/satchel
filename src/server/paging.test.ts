import { describe, expect, it } from 'vitest'
import { pageOf } from './paging.ts'

const items = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']
const size = (item: string) => item.length

describe('pageOf', () => {
  it('takes whole items until the budget would be exceeded', () => {
    expect(pageOf({ items, offset: 0, maxChars: 10, size })).toEqual({
      items: ['aaaa', 'bbbb'],
      start: 0,
      end: 2,
      total: 5,
    })
  })

  it('continues from the offset and stops at the limit', () => {
    const page = pageOf({ items, offset: 2, limit: 2, maxChars: 100, size })
    expect(page).toEqual({ items: ['cccc', 'dddd'], start: 2, end: 4, total: 5 })
  })

  it('always shows one item, even one larger than the budget', () => {
    expect(pageOf({ items: ['x'.repeat(50)], offset: 0, maxChars: 10, size }).items).toHaveLength(1)
  })

  it('is empty past the end', () => {
    expect(pageOf({ items, offset: 9, maxChars: 100, size })).toEqual({
      items: [],
      start: 5,
      end: 5,
      total: 5,
    })
  })
})
