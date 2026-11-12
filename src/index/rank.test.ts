import { describe, expect, it } from 'vitest'
import { cosine, reciprocalRankFusion } from './rank.ts'

describe('reciprocalRankFusion', () => {
  it('ranks an item present in both lists above items in one', () => {
    const scores = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'd'],
    ])
    const order = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
    expect(order[0]).toBe('c')
    expect(order).toHaveLength(4)
  })

  it('is empty for no lists', () => {
    expect(reciprocalRankFusion([]).size).toBe(0)
  })
})

describe('cosine', () => {
  it('is 1 for parallel, 0 for orthogonal, 0 for zero vectors', () => {
    expect(cosine(Float32Array.of(1, 2), Float32Array.of(2, 4))).toBeCloseTo(1)
    expect(cosine(Float32Array.of(1, 0), Float32Array.of(0, 1))).toBeCloseTo(0)
    expect(cosine(Float32Array.of(0, 0), Float32Array.of(1, 1))).toBe(0)
  })
})
