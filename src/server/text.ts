// Stored text is untrusted when it comes back out. These helpers keep it from changing the
// structure of what the server renders around it.

const ELLIPSIS = '…'
// Line breaks, tabs, other control characters and invisible format characters (bidi
// overrides, zero-width joiners) all collapse to one space.
const LINE_BREAKING = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu
// Inside a block, newlines survive (as \n only) but every other control character goes.
const NON_NEWLINE_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const CARRIAGE_RETURN = /\r\n?/g

export function truncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}${ELLIPSIS}`
}

/** One line, at most `max` characters. */
export function flattenLine(text: string, max: number): string {
  return truncate(text.replace(LINE_BREAKING, ' ').trim(), max)
}

function cleanLine(line: string): string {
  return line.replace(NON_NEWLINE_CONTROL, ' ').trimEnd()
}

/** Multi-line text with every line after the first indented, so it stays inside its entry. */
export function indentContinuation(text: string, indent: string): string {
  const lines = text.replace(CARRIAGE_RETURN, '\n').trim().split('\n').map(cleanLine)
  return lines.filter((line) => line.trim() !== '').join(`\n${indent}`)
}

/** "2026-11-12" from an ISO timestamp; the raw value, flattened, when it does not parse. */
export function isoDate(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return flattenLine(timestamp, 32)
  return parsed.toISOString().slice(0, 10)
}

/** "2026-11-12 18:04 UTC" from an ISO timestamp. */
export function isoMinute(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return flattenLine(timestamp, 32)
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
