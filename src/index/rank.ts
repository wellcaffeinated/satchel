const RRF_K = 60

/**
 * Reciprocal rank fusion over ranked id lists (best first). Higher is better. `rankBonus`
 * lets an item count as ranking that many places higher in each list it appears in.
 */
export function reciprocalRankFusion(
  lists: string[][],
  options: { rankBonus?: (id: string) => number } = {},
): Map<string, number> {
  const bonusOf = options.rankBonus ?? (() => 0)
  const scores = new Map<string, number>()
  for (const list of lists) {
    for (const [rank, id] of list.entries()) {
      const effectiveRank = Math.max(0, rank - bonusOf(id))
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + effectiveRank + 1))
    }
  }
  return scores
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  const sums = a.slice(0, length).reduce(
    (acc, x, i) => {
      const y = b[i] ?? 0
      return { dot: acc.dot + x * y, a: acc.a + x * x, b: acc.b + y * y }
    },
    { dot: 0, a: 0, b: 0 },
  )
  if (sums.a === 0 || sums.b === 0) return 0
  return sums.dot / Math.sqrt(sums.a * sums.b)
}
