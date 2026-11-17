// Pages of whole items under a size budget. See docs/design.md "Paging".

export interface Page<T> {
  items: T[]
  /** Index of the first item shown. */
  start: number
  /** Index after the last item shown: the next page's offset. */
  end: number
  total: number
}

/** Each size added to all before it: where each item ends. */
export function runningTotals(sizes: number[]): number[] {
  const totals: number[] = []
  for (const size of sizes) totals.push((totals.at(-1) ?? 0) + size)
  return totals
}

/** How many leading items fit in `maxChars`; at least one, so a page always makes progress. */
function countWithin(sizes: number[], maxChars: number): number {
  const totals = runningTotals(sizes)
  const firstOver = totals.findIndex((total) => total > maxChars)
  if (firstOver === -1) return sizes.length
  return Math.max(1, firstOver)
}

export function pageOf<T>(options: {
  items: T[]
  offset: number
  limit?: number
  maxChars: number
  size: (item: T) => number
}): Page<T> {
  const { items, offset, limit, maxChars, size } = options
  const start = Math.min(Math.max(0, offset), items.length)
  const candidates = items.slice(start, limit === undefined ? undefined : start + limit)
  const shown = candidates.slice(0, countWithin(candidates.map(size), maxChars))
  return { items: shown, start, end: start + shown.length, total: items.length }
}
