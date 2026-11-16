import { describe, expect, it } from 'vitest'
import { flattenLine, isoDate, isoMinute } from './text.ts'

describe('isoDate', () => {
  it('gives the day in the requested zone', () => {
    expect(isoDate('2026-11-16T03:30:00Z', 'UTC')).toBe('2026-11-16')
    expect(isoDate('2026-11-16T03:30:00Z', 'America/Toronto')).toBe('2026-11-15')
    expect(isoDate('2026-07-01T23:30:00Z', 'Asia/Tokyo')).toBe('2026-07-02')
  })

  it('passes an unparsable value through flattened', () => {
    expect(isoDate('not a date\n- forged', 'UTC')).toBe('not a date - forged')
  })
})

describe('isoMinute', () => {
  it('gives the minute in the requested zone with its short name', () => {
    expect(isoMinute('2026-11-12T18:04:00Z', 'UTC')).toBe('2026-11-12 18:04 UTC')
    expect(isoMinute('2026-11-12T18:04:00Z', 'America/Toronto')).toBe('2026-11-12 13:04 EST')
    expect(isoMinute('2026-07-12T18:04:00Z', 'America/Toronto')).toBe('2026-07-12 14:04 EDT')
  })

  it('never shows a 24 hour', () => {
    expect(isoMinute('2026-11-12T00:05:00Z', 'UTC')).toBe('2026-11-12 00:05 UTC')
  })
})

describe('flattenLine', () => {
  it('collapses line breaks and truncates with an ellipsis', () => {
    expect(flattenLine('a\n\tb', 10)).toBe('a b')
    expect(flattenLine('abcdefghij', 5)).toBe('abcd…')
  })
})
