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

  it('lists a topic newest first', () => {
    const index = create()
    add(index, memory('m_aaaaaaaa', 'old', { updated: '2026-01-01T00:00:00Z' }))
    add(index, memory('m_bbbbbbbb', 'new', { updated: '2026-02-01T00:00:00Z' }))
    expect(index.search({ topic: 'general', limit: 5 }).map((m) => m.id)).toEqual([
      'm_bbbbbbbb',
      'm_aaaaaaaa',
    ])
  })
})
