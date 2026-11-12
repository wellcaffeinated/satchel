// Turns arbitrary user text into a safe FTS5 MATCH expression.

const MAX_TERMS = 32
const STOPWORDS = new Set(
  'a an and are as at be but by do does for from how i if in is it its my of on or our so that the their then there these this to was we what when where which who why with you your'.split(
    ' ',
  ),
)
const WORD = /[\p{L}\p{N}]+/gu

/** Distinct lowercase word tokens of `text` (letters and digits only). */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(WORD) ?? []
  return [...new Set(words)].slice(0, MAX_TERMS)
}

/**
 * Every token is double-quoted, so FTS operators and column filters in user text are plain
 * strings, and tokens are OR-ed; bm25 puts multi-term matches first.
 * Returns undefined when there is nothing searchable.
 */
export function matchQueryFromTokens(tokens: string[]): string | undefined {
  if (tokens.length === 0) return undefined
  return tokens.map((token) => `"${token}"`).join(' OR ')
}

/** Drops stopwords, which would match nearly everything, unless nothing else is left. */
function withoutStopwords(tokens: string[]): string[] {
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token))
  return meaningful.length > 0 ? meaningful : tokens
}

export function toMatchQuery(text: string): string | undefined {
  return matchQueryFromTokens(withoutStopwords(tokenize(text)))
}
