import { describe, expect, it } from 'vitest'
import { formatTimestamp, normaliseTime } from './time.ts'

describe('normaliseTime', () => {
  it('keeps a day as a day', () => {
    expect(normaliseTime('2026-12-03')).toBe('2026-12-03')
    expect(normaliseTime(' 2026-12-03 ')).toBe('2026-12-03')
  })

  it('turns a timestamp into UTC without milliseconds', () => {
    expect(normaliseTime('2026-12-03T10:30:00+02:00')).toBe('2026-12-03T08:30:00Z')
    expect(normaliseTime('2026-12-03T08:30:00.123Z')).toBe('2026-12-03T08:30:00Z')
  })

  it.each(['soon', '2026-13-45', '12/03/2026', 'December 3', ''])('rejects %j', (value) => {
    expect(normaliseTime(value)).toBeUndefined()
  })
})

describe('formatTimestamp', () => {
  it('drops milliseconds', () => {
    expect(formatTimestamp(new Date('2026-11-12T18:04:00.500Z'))).toBe('2026-11-12T18:04:00Z')
  })
})
