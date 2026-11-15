import { createHash } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { log } from '../log.ts'
import type { Checkpoint, Memory, Scope } from '../types.ts'
import { matchQueryFromTokens, tokenize, toMatchQuery } from './fts-query.ts'
import { cosine, reciprocalRankFusion } from './rank.ts'

const SCHEMA_VERSION = 1
/** Candidates taken from each ranked list before fusion. */
const CANDIDATES_PER_LIST = 100
/** Cosine below this is noise, not a paraphrase. Tuned against bge-small. */
const VECTOR_MIN_SCORE = 0.52
/** Cosine at or above this counts as "the same fact" for memorize's similar list. */
const SIMILAR_MIN_SCORE = 0.75
const SIMILAR_FTS_CANDIDATES = 10
const SIMILAR_MIN_TERM_LENGTH = 4
const SIMILAR_MIN_SHARED_TERMS = 2
const SIMILAR_MIN_SHARED_RATIO = 0.3
const BYTES_PER_FLOAT = 4

const INDEX_TABLES = ['files', 'memories', 'checkpoints', 'memories_fts', 'vectors']

const CREATE_INDEX_TABLES = `
  CREATE TABLE files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL);
  CREATE INDEX files_id ON files(id);
  CREATE TABLE memories(
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, scope TEXT NOT NULL, project TEXT, host TEXT,
    created TEXT NOT NULL, updated TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
    text_hash TEXT NOT NULL);
  CREATE INDEX memories_topic ON memories(topic);
  CREATE TABLE checkpoints(
    id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, commit_hash TEXT NOT NULL,
    updated TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, UNIQUE(project, branch));
  CREATE VIRTUAL TABLE memories_fts USING fts5(
    id UNINDEXED, text, topic, tokenize = 'porter unicode61');
  CREATE TABLE vectors(id TEXT PRIMARY KEY, model TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL);
`

// The recall log is usage data: it is created here but never dropped by a rebuild.
const CREATE_RECALL_LOG = `
  CREATE TABLE IF NOT EXISTS recall_log(memory_id TEXT NOT NULL, ts TEXT NOT NULL, client TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS recall_log_memory ON recall_log(memory_id);
`

type Row = Record<string, SQLOutputValue>

export interface SearchFilter {
  topic?: string
  /** Hides other projects' project-scoped memories. */
  project?: string
}

export interface SearchInput extends SearchFilter {
  query?: string
  limit: number
  /** Embedding of `query`, with the model that produced it. */
  queryVector?: { model: string; vector: Float32Array }
}

export interface SimilarInput {
  text: string
  excludeId: string
  limit: number
  vector?: { model: string; vector: Float32Array }
}

export interface PendingEmbedding {
  id: string
  text: string
  textHash: string
}

export interface SearchIndex {
  /** Content hash per indexed file path. */
  fileHashes(): Map<string, string>
  upsertMemory(input: { path: string; hash: string; memory: Memory }): void
  upsertCheckpoint(input: { path: string; hash: string; checkpoint: Checkpoint }): void
  deleteByPath(path: string): void
  pathOfId(id: string): string | undefined
  kindOfId(id: string): 'memory' | 'checkpoint' | undefined
  getMemory(id: string): Memory | undefined
  findCheckpoint(project: string, branch: string): Checkpoint | undefined
  listCheckpoints(project: string, branch?: string): Checkpoint[]
  topicCounts(): Map<string, number>
  projectMemoryCount(project: string): number
  search(input: SearchInput): Memory[]
  similar(input: SimilarInput): Memory[]
  setVector(input: { id: string; model: string; textHash: string; vector: Float32Array }): void
  pendingEmbeddings(input: { model: string; limit: number }): PendingEmbedding[]
  vectorCount(model: string): number
  logRecall(input: { ids: string[]; client: string }): void
  /** Drops and recreates every index table except recall_log. */
  rebuild(): void
  close(): void
}

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

const SCOPE_BY_NAME: Record<string, Scope> = { global: 'global', project: 'project', host: 'host' }

function toMemory(row: Row): Memory {
  const project = optionalText(row, 'project')
  const host = optionalText(row, 'host')
  return {
    id: text(row, 'id'),
    topic: text(row, 'topic'),
    scope: SCOPE_BY_NAME[text(row, 'scope')] ?? 'global',
    ...(project === undefined ? {} : { project }),
    ...(host === undefined ? {} : { host }),
    created: text(row, 'created'),
    updated: text(row, 'updated'),
    source: text(row, 'source'),
    text: text(row, 'text'),
  }
}

function toCheckpoint(row: Row): Checkpoint {
  return {
    id: text(row, 'id'),
    project: text(row, 'project'),
    branch: text(row, 'branch'),
    commit: text(row, 'commit_hash'),
    updated: text(row, 'updated'),
    source: text(row, 'source'),
    summary: text(row, 'summary'),
  }
}

export function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  )
}

function blobToVector(value: SQLOutputValue | undefined): Float32Array {
  if (!(value instanceof Uint8Array)) return new Float32Array(0)
  const copy = value.slice()
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / BYTES_PER_FLOAT))
}

function filterClause({ topic, project }: SearchFilter): { sql: string; params: SQLInputValue[] } {
  const parts = [
    { sql: 'm.topic = ?', value: topic },
    { sql: "(m.scope != 'project' OR m.project = ?)", value: project },
  ].filter((part) => part.value !== undefined)
  return {
    sql: ['1 = 1', ...parts.map((part) => part.sql)].join(' AND '),
    params: parts.map((part) => part.value ?? null),
  }
}

function prepareDatabase(db: DatabaseSync): DatabaseSync {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  const versionRow = db.prepare('PRAGMA user_version').get()
  const version = Number(versionRow?.user_version ?? 0)
  if (version !== SCHEMA_VERSION) {
    dropIndexTables(db)
    db.exec(CREATE_INDEX_TABLES)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  db.exec(CREATE_RECALL_LOG)
  return db
}

function dropIndexTables(db: DatabaseSync): void {
  for (const table of INDEX_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
}

function discardFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
}

function openDatabase(path: string): DatabaseSync {
  try {
    return prepareDatabase(new DatabaseSync(path))
  } catch (error) {
    const quarantined = `${path}.corrupt-${Date.now()}`
    log.warn('index.sqlite unreadable, starting a fresh index', {
      error: String(error),
      quarantined,
    })
    try {
      renameSync(path, quarantined)
    } catch {
      discardFile(path)
    }
    return prepareDatabase(new DatabaseSync(path))
  }
}

export function createSearchIndex({ path }: { path: string }): SearchIndex {
  const db = openDatabase(path)

  function all(sql: string, params: SQLInputValue[] = []): Row[] {
    return db.prepare(sql).all(...params)
  }

  function one(sql: string, params: SQLInputValue[] = []): Row | undefined {
    return db.prepare(sql).get(...params)
  }

  function run(sql: string, params: SQLInputValue[] = []): void {
    db.prepare(sql).run(...params)
  }

  function transaction(work: () => void): void {
    db.exec('BEGIN')
    try {
      work()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function removeRowsForId(id: string): void {
    run('DELETE FROM memories WHERE id = ?', [id])
    run('DELETE FROM memories_fts WHERE id = ?', [id])
    run('DELETE FROM vectors WHERE id = ?', [id])
    run('DELETE FROM checkpoints WHERE id = ?', [id])
  }

  function claimId({ id, path: filePath }: { id: string; path: string }): void {
    const owner = one('SELECT path FROM files WHERE id = ? AND path != ?', [id, filePath])
    if (owner) throw new Error(`id ${id} is already used by ${text(owner, 'path')}`)
  }

  function upsertMemory({
    path: filePath,
    hash,
    memory,
  }: Parameters<SearchIndex['upsertMemory']>[0]) {
    transaction(() => {
      claimId({ id: memory.id, path: filePath })
      removeRowsForId(memory.id)
      run('DELETE FROM files WHERE path = ?', [filePath])
      run('INSERT INTO files(path, hash, kind, id) VALUES (?, ?, ?, ?)', [
        filePath,
        hash,
        'memory',
        memory.id,
      ])
      run(
        `INSERT INTO memories(id, topic, scope, project, host, created, updated, source, text, text_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memory.id,
          memory.topic,
          memory.scope,
          memory.project ?? null,
          memory.host ?? null,
          memory.created,
          memory.updated,
          memory.source,
          memory.text,
          hashText(memory.text),
        ],
      )
      run('INSERT INTO memories_fts(id, text, topic) VALUES (?, ?, ?)', [
        memory.id,
        memory.text,
        memory.topic,
      ])
    })
  }

  function upsertCheckpoint({
    path: filePath,
    hash,
    checkpoint,
  }: Parameters<SearchIndex['upsertCheckpoint']>[0]) {
    transaction(() => {
      claimId({ id: checkpoint.id, path: filePath })
      const twin = one('SELECT id FROM checkpoints WHERE project = ? AND branch = ? AND id != ?', [
        checkpoint.project,
        checkpoint.branch,
        checkpoint.id,
      ])
      if (twin)
        throw new Error(`checkpoint for ${checkpoint.project}@${checkpoint.branch} already exists`)
      removeRowsForId(checkpoint.id)
      run('DELETE FROM files WHERE path = ?', [filePath])
      run('INSERT INTO files(path, hash, kind, id) VALUES (?, ?, ?, ?)', [
        filePath,
        hash,
        'checkpoint',
        checkpoint.id,
      ])
      run(
        `INSERT INTO checkpoints(id, project, branch, commit_hash, updated, source, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          checkpoint.id,
          checkpoint.project,
          checkpoint.branch,
          checkpoint.commit,
          checkpoint.updated,
          checkpoint.source,
          checkpoint.summary,
        ],
      )
    })
  }

  function deleteByPath(filePath: string): void {
    const file = one('SELECT id FROM files WHERE path = ?', [filePath])
    if (!file) return
    transaction(() => {
      removeRowsForId(text(file, 'id'))
      run('DELETE FROM files WHERE path = ?', [filePath])
    })
  }

  function getMemory(id: string): Memory | undefined {
    const row = one('SELECT * FROM memories WHERE id = ?', [id])
    return row ? toMemory(row) : undefined
  }

  function memoriesByIds(ids: string[]): Map<string, Memory> {
    return new Map(ids.flatMap((id) => getMemory(id) ?? []).map((memory) => [memory.id, memory]))
  }

  function ftsCandidates({
    match,
    filter,
    limit,
  }: {
    match: string
    filter: SearchFilter
    limit: number
  }): Memory[] {
    const clause = filterClause(filter)
    return all(
      `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.id
       WHERE memories_fts MATCH ? AND ${clause.sql}
       ORDER BY bm25(memories_fts, 0, 1.0, 0.5) LIMIT ?`,
      [match, ...clause.params, limit],
    ).map(toMemory)
  }

  function vectorCandidates({
    model,
    vector,
    filter,
    minScore,
    limit,
  }: {
    model: string
    vector: Float32Array
    filter: SearchFilter
    minScore: number
    limit: number
  }): { id: string; score: number }[] {
    const clause = filterClause(filter)
    return all(
      `SELECT m.id AS id, v.vec AS vec FROM vectors v JOIN memories m ON m.id = v.id
       WHERE v.model = ? AND ${clause.sql}`,
      [model, ...clause.params],
    )
      .map((row) => ({ id: text(row, 'id'), score: cosine(vector, blobToVector(row.vec)) }))
      .filter((candidate) => candidate.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  function byProjectFirst(project: string | undefined, memories: Memory[]): Memory[] {
    if (project === undefined) return memories
    const rank = (memory: Memory) => (memory.project === project ? 0 : 1)
    return memories.toSorted((a, b) => rank(a) - rank(b))
  }

  function listTopic({ topic, project, limit }: SearchFilter & { limit: number }): Memory[] {
    const clause = filterClause({ topic, project })
    return all(
      `SELECT m.* FROM memories m WHERE ${clause.sql}
       ORDER BY CASE WHEN m.project = ? THEN 0 ELSE 1 END, m.updated DESC LIMIT ?`,
      [...clause.params, project ?? null, limit],
    ).map(toMemory)
  }

  function hybridSearch({
    query,
    topic,
    project,
    limit,
    queryVector,
  }: SearchInput & { query: string }) {
    const filter = { topic, project }
    const match = toMatchQuery(query)
    const textHits = match ? ftsCandidates({ match, filter, limit: CANDIDATES_PER_LIST }) : []
    const vectorHits = queryVector
      ? vectorCandidates({
          ...queryVector,
          filter,
          minScore: VECTOR_MIN_SCORE,
          limit: CANDIDATES_PER_LIST,
        })
      : []
    const scores = reciprocalRankFusion([
      textHits.map((memory) => memory.id),
      vectorHits.map((hit) => hit.id),
    ])
    const known = new Map(textHits.map((memory) => [memory.id, memory]))
    const vectorOnly = vectorHits.map((hit) => hit.id).filter((id) => !known.has(id))
    const byId = new Map([...known, ...memoriesByIds(vectorOnly)])
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .flatMap(([id]) => byId.get(id) ?? [])
    return byProjectFirst(project, ranked).slice(0, limit)
  }

  function search(input: SearchInput): Memory[] {
    if (input.query?.trim()) return hybridSearch({ ...input, query: input.query })
    return listTopic(input)
  }

  function similarByVector({
    vector,
    excludeId,
    limit,
  }: {
    vector: { model: string; vector: Float32Array }
    excludeId: string
    limit: number
  }) {
    const hits = vectorCandidates({
      ...vector,
      filter: {},
      minScore: SIMILAR_MIN_SCORE,
      limit: limit + 1,
    }).filter((hit) => hit.id !== excludeId)
    return [...memoriesByIds(hits.slice(0, limit).map((hit) => hit.id)).values()]
  }

  function similarByText({ text: body, excludeId, limit }: SimilarInput): Memory[] {
    const terms = tokenize(body).filter((term) => term.length >= SIMILAR_MIN_TERM_LENGTH)
    const match = matchQueryFromTokens(terms)
    if (!match || terms.length < SIMILAR_MIN_SHARED_TERMS) return []
    const required = Math.max(
      SIMILAR_MIN_SHARED_TERMS,
      Math.ceil(terms.length * SIMILAR_MIN_SHARED_RATIO),
    )
    const termSet = new Set(terms)
    const sharedTerms = (memory: Memory) =>
      tokenize(memory.text).filter((term) => termSet.has(term)).length
    return ftsCandidates({ match, filter: {}, limit: SIMILAR_FTS_CANDIDATES })
      .filter((memory) => memory.id !== excludeId && sharedTerms(memory) >= required)
      .slice(0, limit)
  }

  function similar(input: SimilarInput): Memory[] {
    if (input.vector) return similarByVector({ ...input, vector: input.vector })
    return similarByText(input)
  }

  function setVector({
    id,
    model,
    textHash,
    vector,
  }: Parameters<SearchIndex['setVector']>[0]): void {
    const current = one('SELECT text_hash FROM memories WHERE id = ?', [id])
    if (!current || text(current, 'text_hash') !== textHash) return
    run('INSERT OR REPLACE INTO vectors(id, model, hash, vec) VALUES (?, ?, ?, ?)', [
      id,
      model,
      textHash,
      vectorToBlob(vector),
    ])
  }

  return {
    fileHashes: () =>
      new Map(all('SELECT path, hash FROM files').map((r) => [text(r, 'path'), text(r, 'hash')])),
    upsertMemory,
    upsertCheckpoint,
    deleteByPath,
    pathOfId(id) {
      return optionalText(one('SELECT path FROM files WHERE id = ?', [id]) ?? {}, 'path')
    },
    kindOfId(id) {
      const kind = optionalText(one('SELECT kind FROM files WHERE id = ?', [id]) ?? {}, 'kind')
      return kind === 'memory' || kind === 'checkpoint' ? kind : undefined
    },
    getMemory,
    findCheckpoint(project, branch) {
      const row = one('SELECT * FROM checkpoints WHERE project = ? AND branch = ?', [
        project,
        branch,
      ])
      return row ? toCheckpoint(row) : undefined
    },
    listCheckpoints(project, branch) {
      const rows =
        branch === undefined
          ? all('SELECT * FROM checkpoints WHERE project = ? ORDER BY updated DESC', [project])
          : all('SELECT * FROM checkpoints WHERE project = ? AND branch = ?', [project, branch])
      return rows.map(toCheckpoint)
    },
    topicCounts() {
      const rows = all('SELECT topic, count(*) AS n FROM memories GROUP BY topic')
      return new Map(rows.map((row) => [text(row, 'topic'), Number(row.n)]))
    },
    projectMemoryCount(project) {
      const row = one(
        "SELECT count(*) AS n FROM memories WHERE scope = 'project' AND project = ?",
        [project],
      )
      return Number(row?.n ?? 0)
    },
    search,
    similar,
    setVector,
    pendingEmbeddings({ model, limit }) {
      return all(
        `SELECT m.id, m.text, m.text_hash FROM memories m LEFT JOIN vectors v ON v.id = m.id
         WHERE v.id IS NULL OR v.model != ? OR v.hash != m.text_hash LIMIT ?`,
        [model, limit],
      ).map((row) => ({
        id: text(row, 'id'),
        text: text(row, 'text'),
        textHash: text(row, 'text_hash'),
      }))
    },
    vectorCount(model) {
      return Number(one('SELECT count(*) AS n FROM vectors WHERE model = ?', [model])?.n ?? 0)
    },
    logRecall({ ids, client }) {
      const ts = new Date().toISOString()
      transaction(() => {
        for (const id of ids) {
          run('INSERT INTO recall_log(memory_id, ts, client) VALUES (?, ?, ?)', [id, ts, client])
        }
      })
    },
    rebuild() {
      dropIndexTables(db)
      db.exec(CREATE_INDEX_TABLES)
    },
    close() {
      db.close()
    },
  }
}
