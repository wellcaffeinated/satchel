import { describe, expect, it } from 'vitest'
import type { Checkpoint, Memory } from '../types.ts'
import { parseCheckpoint, parseMemory, renderCheckpoint, renderMemory } from './memory-files.ts'

const MEMORY: Memory = {
  id: 'm_abcdefgh',
  topic: 'travel',
  kind: 'event',
  origin: 'stated',
  date: '2026-12-03',
  expires: '2026-12-04',
  about: ['person:alice', 'place:lisbon'],
  scope: 'global',
  tags: ['travel'],
  created: '2026-11-12T18:04:00Z',
  updated: '2026-11-12T18:04:00Z',
  source: 'claude-code',
  text: 'Alice flies to Lisbon on Dec 3.',
}

describe('memory files', () => {
  it('round trips kind, origin, date, expires and about', () => {
    const raw = renderMemory(MEMORY)
    expect(raw).toContain('kind: event')
    expect(raw).toContain('origin: stated')
    expect(raw).toContain('date: 2026-12-03')
    expect(raw).toContain('expires: 2026-12-04')
    expect(raw).toContain('about: [ person:alice, place:lisbon ]')
    expect(parseMemory(raw)).toEqual(MEMORY)
  })

  it('defaults kind to fact and origin to inferred for files written before they existed', () => {
    const raw = [
      '---',
      'id: m_abcdefgh',
      'topic: travel',
      'created: 2026-11-12T18:04:00Z',
      '---',
      'Plain fact.',
    ].join('\n')
    expect(parseMemory(raw)).toMatchObject({
      kind: 'fact',
      origin: 'inferred',
      text: 'Plain fact.',
    })
  })

  it.each([
    ['kind: wish', /invalid kind/],
    ['kind: event', /event without a date/],
    ['origin: guessed', /invalid origin/],
    ['expires: soon', /not a date/],
    ['date: 2026-13-01', /not a date/],
  ])('treats a file with %j as malformed', (line, message) => {
    const raw = [
      '---',
      'id: m_abcdefgh',
      'topic: t',
      'created: 2026-11-12T18:04:00Z',
      line,
      '---',
      'x',
    ]
    expect(() => parseMemory(raw.join('\n'))).toThrow(message)
  })

  it('normalises a timestamp with an offset to UTC', () => {
    const raw = [
      '---',
      'id: m_abcdefgh',
      'topic: t',
      'created: 2026-11-12T18:04:00Z',
      'expires: 2026-12-03T10:00:00+02:00',
      '---',
      'x',
    ].join('\n')
    expect(parseMemory(raw).expires).toBe('2026-12-03T08:00:00Z')
  })
})

const CHECKPOINT: Checkpoint = {
  id: 'c_abcdefgh',
  context: 'grant-proposal',
  thread: 'main',
  updated: '2026-11-12T18:04:00Z',
  source: 'claude-code',
  summary: 'Budget drafted.',
}

describe('checkpoint files', () => {
  it('round trips a thread without a commit', () => {
    const raw = renderCheckpoint(CHECKPOINT)
    expect(raw).not.toContain('commit')
    expect(parseCheckpoint(raw)).toEqual(CHECKPOINT)
  })

  it('reads project and branch as context and thread', () => {
    const raw = [
      '---',
      'id: c_abcdefgh',
      'project: github.com/o/r',
      'branch: dev',
      'commit: abc1234',
      'updated: 2026-11-12T18:04:00Z',
      '---',
      'Old style.',
    ].join('\n')
    expect(parseCheckpoint(raw)).toMatchObject({
      context: 'github.com/o/r',
      thread: 'dev',
      commit: 'abc1234',
      summary: 'Old style.',
    })
  })

  it('defaults the thread to main', () => {
    const raw = [
      '---',
      'id: c_abcdefgh',
      'context: grant',
      'updated: 2026-11-12T18:04:00Z',
      '---',
      '',
    ].join('\n')
    expect(parseCheckpoint(raw).thread).toBe('main')
  })
})
