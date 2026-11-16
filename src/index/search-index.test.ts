import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../store/test-helpers.ts'
import type { Memory } from '../types.ts'
import { createSearchIndex, hashText, type SearchIndex } from './search-index.ts'

function memory(id: string, text: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    topic: 'general',
    kind: 'fact',
    origin: 'inferred',
    scope: 'global',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    source: 'test',
    text,
    ...extra,
  }
}

describe('search index', () => {
  const temp = { path: '', remove: (): undefined => undefined }
  const open: SearchIndex[] = []
  const dbPath = () => join(temp.path, 'index.sqlite')

  function create(): SearchIndex {
    const index = createSearchIndex({ path: dbPath() })
    open.push(index)
    return index
  }

  function add(index: SearchIndex, entry: Memory) {
    index.upsertMemory({ path: `memories/${entry.id}.md`, hash: entry.id, memory: entry })
  }

  beforeEach(() => {
    Object.assign(temp, createTempDir())
  })

  afterEach(() => {
    for (const index of open.splice(0)) {
      try {
        index.close()
      } catch {
        // already closed
      }
    }
    temp.remove()
  })

  it('ranks by bm25 and hides other projects', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'kettle descaling schedule'))
    add(index, memory('m_bbbbbbbb', 'kettle', { scope: 'project', project: 'one' }))
    add(index, memory('m_cccccccc', 'kettle kettle kettle', { scope: 'project', project: 'two' }))
    const found = index.search({ query: 'kettle', project: 'one', limit: 10 })
    expect(found.map((m) => m.id)).toEqual(['m_bbbbbbbb', 'm_aaaaaaaa'])
  })

  it('ranks this host first and hides other hosts', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'backup schedule for everything'))
    add(index, memory('m_bbbbbbbb', 'backup schedule', { scope: 'host', host: 'nas' }))
    add(index, memory('m_cccccccc', 'backup backup schedule', { scope: 'host', host: 'desktop' }))
    const found = index.search({ query: 'backup schedule', host: 'nas', limit: 10 })
    expect(found.map((m) => m.id)).toEqual(['m_bbbbbbbb', 'm_aaaaaaaa'])
    const anywhere = index.search({ query: 'backup schedule', limit: 10 })
    expect(anywhere.map((m) => m.id).toSorted()).toEqual(['m_aaaaaaaa', 'm_bbbbbbbb', 'm_cccccccc'])
  })

  it('lists only one host and counts host memories per host', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'general fact'))
    add(index, memory('m_bbbbbbbb', 'nas fact one', { scope: 'host', host: 'nas' }))
    add(index, memory('m_cccccccc', 'nas fact two', { scope: 'host', host: 'nas' }))
    add(index, memory('m_dddddddd', 'desktop fact', { scope: 'host', host: 'desktop' }))
    const listed = index.search({ host: 'nas', hostScopedOnly: true, limit: 10 })
    expect(listed.map((m) => m.id).toSorted()).toEqual(['m_bbbbbbbb', 'm_cccccccc'])
    expect([...index.hostCounts()].toSorted()).toEqual([
      ['desktop', 1],
      ['nas', 2],
    ])
  })

  it('fuses vector hits that share no words with the query', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'alpha'))
    add(index, memory('m_bbbbbbbb', 'beta'))
    index.setVector({
      id: 'm_aaaaaaaa',
      model: 'm',
      textHash: hashText('alpha'),
      vector: Float32Array.of(1, 0),
    })
    index.setVector({
      id: 'm_bbbbbbbb',
      model: 'm',
      textHash: hashText('beta'),
      vector: Float32Array.of(0, 1),
    })
    const found = index.search({
      query: 'unrelated words',
      limit: 5,
      queryVector: { model: 'm', vector: Float32Array.of(0.9, 0.1) },
    })
    expect(found.map((m) => m.id)).toEqual(['m_aaaaaaaa'])
  })

  it('ignores vectors from another model and stale vectors', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'alpha'))
    index.setVector({
      id: 'm_aaaaaaaa',
      model: 'old',
      textHash: hashText('alpha'),
      vector: Float32Array.of(1, 0),
    })
    expect(index.pendingEmbeddings({ model: 'new', limit: 10 }).map((p) => p.id)).toEqual([
      'm_aaaaaaaa',
    ])
    index.setVector({
      id: 'm_aaaaaaaa',
      model: 'new',
      textHash: 'stale',
      vector: Float32Array.of(1, 0),
    })
    expect(index.vectorCount('new')).toBe(0)
    add(index, memory('m_aaaaaaaa', 'alpha changed'))
    expect(index.pendingEmbeddings({ model: 'old', limit: 10 })).toHaveLength(1)
  })

  it('keeps recall_log across a rebuild and empties the index tables', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'alpha'))
    index.logRecall({ ids: ['m_aaaaaaaa'], client: 'c' })
    index.rebuild()
    expect(index.search({ query: 'alpha', limit: 5 })).toEqual([])
    expect(index.fileHashes().size).toBe(0)
    index.close()
    const db = new DatabaseSync(dbPath(), { readOnly: true })
    expect(db.prepare('SELECT count(*) AS n FROM recall_log').get()?.n).toBe(1)
    db.close()
  })

  it('rejects a second file claiming an existing id', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'alpha'))
    expect(() =>
      index.upsertMemory({
        path: 'memories/copy.md',
        hash: 'x',
        memory: memory('m_aaaaaaaa', 'alpha'),
      }),
    ).toThrow(/already used/)
  })

  it('lists a topic in creation order, so an import keeps its source order', () => {
    const index = create()
    add(index, memory('m_bbbbbbbb', 'second', { created: '2026-02-01T00:00:00Z' }))
    add(index, memory('m_aaaaaaaa', 'first', { created: '2026-01-01T00:00:00Z' }))
    expect(index.search({ topic: 'general' }).map((m) => m.id)).toEqual([
      'm_aaaaaaaa',
      'm_bbbbbbbb',
    ])
  })

  it('loads by label: every field a memory sets must match the work', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'any code', { tags: ['code'] }))
    add(index, memory('m_bbbbbbbb', 'typescript', { filetypes: ['ts', 'js'] }))
    add(index, memory('m_cccccccc', 'rxjs in ts', { filetypes: ['ts'], tags: ['rxjs'] }))
    add(index, memory('m_dddddddd', 'python', { filetypes: ['py'] }))
    add(index, memory('m_eeeeeeee', 'unlabelled'))
    const ids = (work: { filetypes?: string[]; tags?: string[] }) =>
      index.search(work).map((m) => m.id)
    expect(ids({ filetypes: ['ts'], tags: ['code'] })).toEqual(['m_aaaaaaaa', 'm_bbbbbbbb'])
    expect(ids({ filetypes: ['ts'], tags: ['code', 'rxjs'] })).toEqual([
      'm_aaaaaaaa',
      'm_bbbbbbbb',
      'm_cccccccc',
    ])
    expect(ids({ filetypes: ['py'] })).toEqual(['m_dddddddd'])
    expect(ids({ tags: ['rxjs'] })).toEqual([])
    expect(index.labelCounts()).toEqual([
      { kind: 'filetype', value: 'ts', count: 2 },
      { kind: 'filetype', value: 'js', count: 1 },
      { kind: 'filetype', value: 'py', count: 1 },
      { kind: 'tag', value: 'code', count: 1 },
      { kind: 'tag', value: 'rxjs', count: 1 },
    ])
  })
  it('filters by any shared about entity and by kind, and counts about values', () => {
    const index = create()
    add(
      index,
      memory('m_aaaaaaaa', 'alice likes tea', { kind: 'preference', about: ['person:alice'] }),
    )
    add(
      index,
      memory('m_bbbbbbbb', 'alice met bob', {
        kind: 'event',
        date: '2026-03-01',
        about: ['person:alice', 'person:bob'],
      }),
    )
    add(index, memory('m_cccccccc', 'carol', { about: ['person:carol'] }))
    add(index, memory('m_dddddddd', 'nobody', { tags: ['code'] }))
    const ids = (input: Parameters<SearchIndex['search']>[0]) =>
      index.search(input).map((m) => m.id)
    expect(ids({ about: ['person:alice'] })).toEqual(['m_aaaaaaaa', 'm_bbbbbbbb'])
    expect(ids({ about: ['person:bob', 'person:carol'] })).toEqual(['m_bbbbbbbb', 'm_cccccccc'])
    expect(ids({ about: ['person:alice'], kind: 'event' })).toEqual(['m_bbbbbbbb'])
    expect(ids({ about: [] })).toEqual([])
    expect(ids({ query: 'alice', about: ['person:bob'], limit: 10 })).toEqual(['m_bbbbbbbb'])
    // About never counts as a work label: this memory has no filetypes or tags to match.
    expect(ids({ tags: ['code'] })).toEqual(['m_dddddddd'])
    expect(index.labelCounts().filter((entry) => entry.kind === 'about')).toEqual([
      { kind: 'about', value: 'person:alice', count: 2 },
      { kind: 'about', value: 'person:bob', count: 1 },
      { kind: 'about', value: 'person:carol', count: 1 },
    ])
    expect(index.getMemory('m_bbbbbbbb')).toMatchObject({ kind: 'event', date: '2026-03-01' })
  })

  it('hides expired memories everywhere except getMemory', () => {
    const clock = { now: new Date('2026-06-01T12:00:00Z') }
    const index = createSearchIndex({ path: dbPath(), now: () => clock.now })
    open.push(index)
    add(index, memory('m_aaaaaaaa', 'kettle still valid', { expires: '2026-07-01' }))
    add(index, memory('m_bbbbbbbb', 'kettle expired', { expires: '2026-05-01', tags: ['code'] }))
    add(index, memory('m_cccccccc', 'kettle expires today', { expires: '2026-06-01T12:00:00Z' }))
    const ids = (input: Parameters<SearchIndex['search']>[0]) =>
      index.search(input).map((m) => m.id)
    expect(ids({ query: 'kettle', limit: 10 })).toEqual(['m_aaaaaaaa'])
    expect(ids({ topic: 'general' })).toEqual(['m_aaaaaaaa'])
    expect(ids({ tags: ['code'] })).toEqual([])
    expect(index.topicCounts().get('general')).toBe(1)
    expect(index.labelCounts()).toEqual([])
    expect(index.getMemory('m_bbbbbbbb')?.expires).toBe('2026-05-01')
    clock.now = new Date('2026-08-01T00:00:00Z')
    expect(ids({ topic: 'general' })).toEqual([])
  })

  it('keeps one checkpoint per context and thread and lists the most recent', () => {
    const index = create()
    const checkpoint = (id: string, context: string, thread: string, updated: string) =>
      index.upsertCheckpoint({
        path: `checkpoints/${id}.md`,
        hash: id,
        checkpoint: { id, context, thread, updated, source: 't', summary: id },
      })
    checkpoint('c_aaaaaaaa', 'repo', 'main', '2026-01-01T00:00:00Z')
    checkpoint('c_bbbbbbbb', 'grant', 'main', '2026-03-01T00:00:00Z')
    checkpoint('c_cccccccc', 'repo', 'dev', '2026-02-01T00:00:00Z')
    expect(index.findCheckpoint('grant', 'main')).toMatchObject({ id: 'c_bbbbbbbb' })
    expect(index.findCheckpoint('grant', 'main')?.commit).toBeUndefined()
    expect(index.listCheckpoints('repo').map((c) => c.id)).toEqual(['c_cccccccc', 'c_aaaaaaaa'])
    expect(index.recentCheckpoints(2).map((c) => c.id)).toEqual(['c_bbbbbbbb', 'c_cccccccc'])
    expect(() => checkpoint('c_dddddddd', 'repo', 'main', '2026-04-01T00:00:00Z')).toThrow(
      /already exists/,
    )
  })
})
