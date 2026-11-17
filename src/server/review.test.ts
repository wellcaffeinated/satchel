import { describe, expect, it } from 'vitest'
import type { Memory, MemoryUsage } from '../types.ts'
import { createFakeStore, type FakeStoreSeed } from './fake-store.ts'
import { createRenderer } from './render.ts'
import {
  coreFit,
  coreScore,
  createReviewer,
  UPKEEP_RULES,
  USAGE_WINDOW_DAYS,
  unusedHints,
  useMultiplier,
} from './review.ts'

const NOW = new Date('2026-11-16T12:00:00Z')
const OLD = '2026-08-01T00:00:00Z'
const RECENT = '2026-11-10T00:00:00Z'

function memory(overrides: Partial<Memory> & Pick<Memory, 'id' | 'text'>): Memory {
  return {
    topic: 'general',
    kind: 'fact',
    origin: 'inferred',
    scope: 'global',
    created: OLD,
    updated: OLD,
    source: 'seed',
    ...overrides,
  }
}

function usage(id: string, extra: Partial<MemoryUsage> = {}): MemoryUsage {
  return { id, lookupDays: 0, loadOnlyDays: 0, contexts: [], lastUsed: RECENT, ...extra }
}

function reviewer(seed: FakeStoreSeed) {
  const store = createFakeStore({ topics: { general: { trigger: 't' } }, ...seed })
  return createReviewer({ store, render: createRenderer({ timeZone: 'UTC' }), now: () => NOW })
}

const PLAIN_WORDS = memory({
  id: 'm_plainwrd',
  kind: 'preference',
  origin: 'stated',
  text: 'Write in plain words.',
})
const COMMIT_RULE = memory({
  id: 'm_commitrl',
  kind: 'rule',
  origin: 'stated',
  tags: ['code'],
  text: 'Commit as you go.',
})
const GUESS = memory({ id: 'm_guessfct', text: 'The owner probably likes tea.' })

describe('core scoring', () => {
  it('multiplies trust, kind and labels into a fit', () => {
    expect(coreFit(PLAIN_WORDS)).toEqual({ trust: 1, kind: 1, labels: 1, value: 100 })
    expect(coreFit(COMMIT_RULE).value).toBe(50)
    expect(coreFit(GUESS).value).toBe(56)
    expect(coreFit({ ...GUESS, origin: 'imported', kind: 'event', date: '2026-01-01' }).value).toBe(
      18,
    )
  })

  it('gives unused memories half their fit and approaches the whole fit with use', () => {
    expect(useMultiplier(undefined)).toBe(0.5)
    expect(useMultiplier(usage('m', { lookupDays: 3 }))).toBe(0.75)
    expect(useMultiplier(usage('m', { loadOnlyDays: 6 }))).toBe(0.75)
    expect(useMultiplier(usage('m', { lookupDays: 300 }))).toBeGreaterThan(0.99)
    expect(coreScore(PLAIN_WORDS, undefined)).toBe(50)
    expect(coreScore(PLAIN_WORDS, usage('m', { lookupDays: 3 }))).toBe(75)
  })
})

describe('unused hints', () => {
  const facts = { activeContexts: new Set(['live-repo']), quietTopics: new Set(['quiet']) }

  it('names metadata to check, or why the silence is expected', () => {
    const rule = memory({ id: 'm_a', kind: 'rule', topic: 'quiet', text: 'Do x.' })
    expect(unusedHints(rule, facts)).toEqual([
      expect.stringContaining('A rule with no filetypes or tags'),
      expect.stringContaining('Nothing in topic "quiet" was used'),
    ])
    const dormant = memory({ id: 'm_b', scope: 'context', context: 'old-repo', text: 'Fact.' })
    expect(unusedHints(dormant, facts)).toEqual([
      expect.stringContaining('No session named its context (old-repo)'),
    ])
    const machine = memory({ id: 'm_c', scope: 'host', host: 'nas', text: 'Fact.' })
    expect(unusedHints(machine, facts)[0]).toContain('host="nas"')
    const labelled = memory({
      id: 'm_e',
      kind: 'rule',
      filetypes: ['ts'],
      tags: ['code'],
      text: 'Do y.',
    })
    expect(unusedHints(labelled, facts)).toEqual([
      expect.stringContaining('passes matching labels (filetypes ts; tags code)'),
    ])
  })

  it('says the metadata looks fine when no hint applies', () => {
    const live = memory({ id: 'm_d', scope: 'context', context: 'live-repo', text: 'Fact.' })
    expect(unusedHints(live, facts)).toEqual([expect.stringContaining('look reasonable')])
  })
})

describe('review', () => {
  it('gives an overview of the core, duplicates and unused memories', async () => {
    const pinned = { ...PLAIN_WORDS, core: true as const }
    const fresh = memory({ id: 'm_freshone', created: RECENT, text: 'Saved last week.' })
    const { review } = reviewer({
      core: 'Hand-written line.',
      memories: [pinned, COMMIT_RULE, GUESS, fresh],
      usage: [usage('m_commitrl', { lookupDays: 4, contexts: ['a', 'b'] })],
      similarPairs: [{ a: 'm_commitrl', b: 'm_guessfct', score: 0.91 }],
    })
    const text = await review({})
    expect(text).toContain(`Usage counts the last ${USAGE_WINDOW_DAYS} days (since 2026-09-17)`)
    expect(text).toMatch(/^Core: \d+ of 4000 characters \(core\.md 18, 1 pinned memory \d+\)\.$/m)
    expect(text).toContain('Pinned: m_plainwrd.')
    expect(text).toContain('- m_commitrl [general] score 39: Commit as you go.')
    expect(text).toContain('1 pair.\n- 0.91: m_commitrl and m_guessfct')
    // Pinned, used and new memories are not unused; the old silent guess is.
    expect(text).toContain('1 memory created before 2026-09-17 that nothing has used since.')
    expect(text).toContain('- m_guessfct [general] unused: The owner probably likes tea.')
    expect(text.endsWith(UPKEEP_RULES)).toBe(true)
    expect(UPKEEP_RULES).toContain('under about 3200 of its 4000 characters')
    expect(UPKEEP_RULES).toContain('First recall topic "memory-upkeep"')
  })

  it('leaves the rules out of a single section', async () => {
    const { review } = reviewer({ memories: [GUESS] })
    expect(await review({ section: 'unused' })).not.toContain('## How to act on this report')
  })

  it('lists pinned memories and scored candidates in the core section', async () => {
    const { review } = reviewer({
      memories: [
        { ...PLAIN_WORDS, core: true },
        COMMIT_RULE,
        { ...GUESS, about: ['person:tea-lover'] },
      ],
      usage: [usage('m_commitrl', { lookupDays: 3, contexts: ['a'] })],
    })
    const text = await review({ section: 'core' })
    expect(text).toContain(
      'Pinned. fit 100 (stated ×1, preference ×1, no labels ×1); use is not measured while pinned.',
    )
    expect(text).toContain(
      'Candidate. Score 38: fit 50 (stated ×1, rule ×1, labelled ×0.5) × use 0.75 (looked up on 3 days, loaded for work on 0 more, from 1 context, last 2026-11-10).',
    )
    expect(text).toContain('Labelled: it already loads for matching work.')
    expect(text).toContain('About person:tea-lover: it loads when a conversation names them.')
    expect(text.indexOf('m_commitrl')).toBeLessThan(text.indexOf('m_guessfct'))
  })

  it('shows both memories of each possible duplicate', async () => {
    const { review } = reviewer({
      memories: [COMMIT_RULE, GUESS],
      similarPairs: [{ a: 'm_commitrl', b: 'm_guessfct', score: 0.875 }],
    })
    const text = await review({ section: 'duplicates' })
    expect(text).toContain('Pair, cosine 0.88:\n- m_commitrl')
    expect(text).toContain('\n- m_guessfct')
  })

  it('pages a long section without cutting an entry', async () => {
    const long = Array.from({ length: 12 }, (_, index) =>
      memory({ id: `m_long${String(index).padStart(4, '0')}`, text: 'x'.repeat(3_000) }),
    )
    const { review } = reviewer({ memories: long })
    const first = await review({ section: 'unused' })
    const next = first.match(/offset=(\d+)/)?.[1]
    expect(first).toMatch(/^Showing 1–\d+ of 12\.$/m)
    expect(next).toBeDefined()
    const second = await review({ section: 'unused', offset: Number(next) })
    expect(second).toContain(`Showing ${Number(next) + 1}–`)
  })
})
