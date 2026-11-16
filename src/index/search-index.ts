import { createHash } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import {
  DEFAULT_MEMORY_KIND,
  DEFAULT_MEMORY_ORIGIN,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
} from '../config.ts'
import { log } from '../log.ts'
import type {
  Checkpoint,
  Memory,
  MemoryKind,
  MemoryOrigin,
  Reference,
  ReferenceSummary,
  Scope,
} from '../types.ts'
import { matchQueryFromTokens, tokenize, toMatchQuery } from './fts-query.ts'
import { cosine, reciprocalRankFusion } from './rank.ts'

const SCHEMA_VERSION = 6
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

const INDEX_TABLES = [
  'files',
  'memories',
  'labels',
  'reference_docs',
  'reference_docs_fts',
  'checkpoints',
  'memories_fts',
  'vectors',
]

const CREATE_INDEX_TABLES = `
  CREATE TABLE files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL);
  CREATE INDEX files_id ON files(id);
  CREATE TABLE memories(
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL,
    date TEXT, expires TEXT, expires_at TEXT,
    scope TEXT NOT NULL, context TEXT, host TEXT,
    filetypes TEXT NOT NULL, tags TEXT NOT NULL, about TEXT NOT NULL,
    created TEXT NOT NULL, updated TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
    text_hash TEXT NOT NULL);
  CREATE INDEX memories_topic ON memories(topic);
  CREATE TABLE labels(id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
  CREATE INDEX labels_id ON labels(id, kind);
  CREATE INDEX labels_value ON labels(kind, value);
  CREATE TABLE reference_docs(
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
    scope TEXT NOT NULL, context TEXT, host TEXT,
    filetypes TEXT NOT NULL, tags TEXT NOT NULL, about TEXT NOT NULL, expires TEXT, expires_at TEXT,
    format TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, source TEXT NOT NULL,
    content TEXT NOT NULL);
  CREATE VIRTUAL TABLE reference_docs_fts USING fts5(
    id UNINDEXED, title, description, topic, tokenize = 'porter unicode61');
  CREATE TABLE checkpoints(
    id TEXT PRIMARY KEY, context TEXT NOT NULL, thread TEXT NOT NULL, commit_hash TEXT,
    updated TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, UNIQUE(context, thread));
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
  /** Hides other contexts' context-scoped memories. */
  context?: string
  /** Hides other machines' host-scoped memories. */
  host?: string
  /** Only host-scoped memories (of `host`, when given). */
  hostScopedOnly?: boolean
  /** Labels of the work: a memory matches when every label field it sets overlaps. */
  filetypes?: string[]
  tags?: string[]
  /** Entities: a memory matches when it carries any of them. */
  about?: string[]
  kind?: MemoryKind
}

export interface SearchInput extends SearchFilter {
  query?: string
  /** Search results kept (listing returns every match). */
  limit?: number
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
  kindOfId(id: string): 'memory' | 'reference' | 'checkpoint' | undefined
  getMemory(id: string): Memory | undefined
  upsertReference(input: { path: string; hash: string; reference: Reference }): void
  getReference(id: string): Reference | undefined
  /** References matching the filter (and query, when given), without content. */
  findReferences(input: SearchFilter & { query?: string; limit: number }): ReferenceSummary[]
  /** topic -> number of references. */
  referenceTopicCounts(): Map<string, number>
  findCheckpoint(context: string, thread: string): Checkpoint | undefined
  getCheckpoint(id: string): Checkpoint | undefined
  /** A context's checkpoints, most recently updated first; one when thread is given. */
  listCheckpoints(context: string, thread?: string): Checkpoint[]
  recentCheckpoints(limit: number): Checkpoint[]
  topicCounts(): Map<string, number>
  /** kind ('filetype' | 'tag' | 'about') -> value -> count, most used first. */
  labelCounts(): { kind: string; value: string; count: number }[]
  contextMemoryCount(context: string): number
  /** host -> number of host-scoped memories. */
  hostCounts(): Map<string, number>
  search(input: SearchInput): Memory[]
  similar(input: SimilarInput): Memory[]
  setVector(input: { id: string; model: string; textHash: string; vector: Float32Array }): void
  pendingEmbeddings(input: { model: string; limit: number }): PendingEmbedding[]
  vectorCount(model: string): number
  logRecall(input: { ids: string[]; client: string }): void
  /** Memories and references whose `expires` has passed, with the files that hold them. */
  expiredEntries(): { id: string; path: string }[]
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

const SCOPE_BY_NAME: Record<string, Scope> = { global: 'global', context: 'context', host: 'host' }
const KIND_BY_NAME = new Map<string, MemoryKind>(MEMORY_KINDS.map((kind) => [kind, kind]))
const ORIGIN_BY_NAME = new Map<string, MemoryOrigin>(
  MEMORY_ORIGINS.map((origin) => [origin, origin]),
)
const MILLIS = /\.\d{3}Z$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Label lists are stored as JSON text beside the row, and one row each in `labels`. */
function labelList(row: Row, key: string): string[] {
  const parsed: unknown = JSON.parse(text(row, key) || '[]')
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
}

/** The scope and label columns shared by memories and references, present only when set. */
function scopedAndLabelled(row: Row) {
  const context = optionalText(row, 'context')
  const host = optionalText(row, 'host')
  const filetypes = labelList(row, 'filetypes')
  const tags = labelList(row, 'tags')
  const about = labelList(row, 'about')
  return {
    scope: SCOPE_BY_NAME[text(row, 'scope')] ?? 'global',
    ...(context === undefined ? {} : { context }),
    ...(host === undefined ? {} : { host }),
    ...(filetypes.length === 0 ? {} : { filetypes }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(about.length === 0 ? {} : { about }),
  }
}

function toMemory(row: Row): Memory {
  const date = optionalText(row, 'date')
  const expires = optionalText(row, 'expires')
  return {
    id: text(row, 'id'),
    topic: text(row, 'topic'),
    kind: KIND_BY_NAME.get(text(row, 'kind')) ?? DEFAULT_MEMORY_KIND,
    origin: ORIGIN_BY_NAME.get(text(row, 'origin')) ?? DEFAULT_MEMORY_ORIGIN,
    ...(date === undefined ? {} : { date }),
    ...(expires === undefined ? {} : { expires }),
    ...scopedAndLabelled(row),
    created: text(row, 'created'),
    updated: text(row, 'updated'),
    source: text(row, 'source'),
    text: text(row, 'text'),
  }
}

function toReferenceSummary(row: Row): ReferenceSummary {
  const expires = optionalText(row, 'expires')
  return {
    id: text(row, 'id'),
    topic: text(row, 'topic'),
    title: text(row, 'title'),
    description: text(row, 'description'),
    ...scopedAndLabelled(row),
    ...(expires === undefined ? {} : { expires }),
    format: text(row, 'format'),
    created: text(row, 'created'),
    updated: text(row, 'updated'),
    source: text(row, 'source'),
  }
}

function toCheckpoint(row: Row): Checkpoint {
  const commit = optionalText(row, 'commit_hash')
  return {
    id: text(row, 'id'),
    context: text(row, 'context'),
    thread: text(row, 'thread'),
    ...(commit === undefined ? {} : { commit }),
    updated: text(row, 'updated'),
    source: text(row, 'source'),
    summary: text(row, 'summary'),
  }
}

/**
 * A stored timestamp as a sortable UTC instant, for the expiry comparison. A day has none:
 * it applies through that whole day in the owner's zone, which `liveClause` checks.
 */
function instantOf(value: string | undefined): string | null {
  if (value === undefined || DAY.test(value)) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace(MILLIS, 'Z')
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

const LABEL_KINDS = { filetypes: 'filetype', tags: 'tag', about: 'about' } as const
/** The label kinds that drive loading by work; `about` only filters. */
const WORK_LABEL_KINDS = `('${LABEL_KINDS.filetypes}', '${LABEL_KINDS.tags}')`

type Clause = { sql: string; params: SQLInputValue[] }

/** Now, as a UTC instant and as the owner's calendar day. */
type Moment = { instant: string; day: string }

/**
 * One label field of the matching rule: a memory that sets this field must share a value
 * with the request; when the request has no values for it, the memory must not set it.
 */
function labelFieldClause(kind: string, values: string[]): Clause {
  const hasField = `EXISTS (SELECT 1 FROM labels l WHERE l.id = m.id AND l.kind = '${kind}')`
  if (values.length === 0) return { sql: `NOT ${hasField}`, params: [] }
  const placeholders = values.map(() => '?').join(', ')
  return {
    sql: `(NOT ${hasField} OR EXISTS (SELECT 1 FROM labels l WHERE l.id = m.id AND l.kind = '${kind}' AND l.value IN (${placeholders})))`,
    params: values,
  }
}

function labelClause(filter: SearchFilter): Clause[] {
  if (filter.filetypes === undefined && filter.tags === undefined) return []
  return [
    {
      sql: `EXISTS (SELECT 1 FROM labels l WHERE l.id = m.id AND l.kind IN ${WORK_LABEL_KINDS})`,
      params: [],
    },
    labelFieldClause(LABEL_KINDS.filetypes, filter.filetypes ?? []),
    labelFieldClause(LABEL_KINDS.tags, filter.tags ?? []),
  ]
}

/** Any shared entity is a match; an empty request list matches nothing. */
function aboutClause(about: string[] | undefined): Clause[] {
  if (about === undefined) return []
  if (about.length === 0) return [{ sql: '0 = 1', params: [] }]
  const placeholders = about.map(() => '?').join(', ')
  return [
    {
      sql: `EXISTS (SELECT 1 FROM labels l WHERE l.id = m.id AND l.kind = '${LABEL_KINDS.about}' AND l.value IN (${placeholders}))`,
      params: about,
    },
  ]
}

/** "2026-11-30": the calendar day `date` falls on in `timeZone`. */
function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(date)
}

/**
 * Expired rows are hidden everywhere but `getMemory`. Every branch is true or false, never
 * NULL, so `NOT` of this clause selects exactly the expired rows.
 */
function liveClause(now: Moment): Clause {
  return {
    sql: `(m.expires IS NULL
      OR (m.expires_at IS NOT NULL AND m.expires_at > ?)
      OR (m.expires_at IS NULL AND m.expires >= ?))`,
    params: [now.instant, now.day],
  }
}

function filterClause(filter: SearchFilter, now: Moment): Clause {
  const { topic, context, host, hostScopedOnly, kind } = filter
  const parts = [
    { sql: 'm.topic = ?', value: topic },
    { sql: "(m.scope != 'context' OR m.context = ?)", value: context },
    { sql: "(m.scope != 'host' OR m.host = ?)", value: host },
    { sql: 'm.kind = ?', value: kind },
  ].filter((part) => part.value !== undefined)
  const hostOnly = hostScopedOnly ? [{ sql: "m.scope = 'host'", params: [] }] : []
  const clauses = [
    liveClause(now),
    ...parts.map((part) => ({ sql: part.sql, params: [part.value ?? null] })),
    ...hostOnly,
    ...labelClause(filter),
    ...aboutClause(filter.about),
  ]
  return {
    sql: ['1 = 1', ...clauses.map((clause) => clause.sql)].join(' AND '),
    params: clauses.flatMap((clause) => clause.params),
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

export function createSearchIndex({
  path,
  now = () => new Date(),
  timeZone = 'UTC',
}: {
  path: string
  now?: () => Date
  /** The owner's IANA zone: a day-valued `expires` lasts until that day ends there. */
  timeZone?: string
}): SearchIndex {
  const db = openDatabase(path)
  const moment = (): Moment => {
    const date = now()
    return { instant: date.toISOString().replace(MILLIS, 'Z'), day: localDay(date, timeZone) }
  }
  const liveFilter = (filter: SearchFilter) => filterClause(filter, moment())

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
    run('DELETE FROM labels WHERE id = ?', [id])
    run('DELETE FROM memories_fts WHERE id = ?', [id])
    run('DELETE FROM vectors WHERE id = ?', [id])
    run('DELETE FROM checkpoints WHERE id = ?', [id])
    run('DELETE FROM reference_docs WHERE id = ?', [id])
    run('DELETE FROM reference_docs_fts WHERE id = ?', [id])
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
        `INSERT INTO memories(id, topic, kind, origin, date, expires, expires_at, scope, context,
           host, filetypes, tags, about, created, updated, source, text, text_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memory.id,
          memory.topic,
          memory.kind,
          memory.origin,
          memory.date ?? null,
          memory.expires ?? null,
          instantOf(memory.expires),
          memory.scope,
          memory.context ?? null,
          memory.host ?? null,
          JSON.stringify(memory.filetypes ?? []),
          JSON.stringify(memory.tags ?? []),
          JSON.stringify(memory.about ?? []),
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
      insertLabels(memory)
    })
  }

  function insertLabels(input: {
    id: string
    filetypes?: string[]
    tags?: string[]
    about?: string[]
  }): void {
    const rows = [
      ...(input.filetypes ?? []).map((value) => [LABEL_KINDS.filetypes, value]),
      ...(input.tags ?? []).map((value) => [LABEL_KINDS.tags, value]),
      ...(input.about ?? []).map((value) => [LABEL_KINDS.about, value]),
    ]
    for (const [kind, value] of rows) {
      run('INSERT INTO labels(id, kind, value) VALUES (?, ?, ?)', [
        input.id,
        kind ?? '',
        value ?? '',
      ])
    }
  }

  function upsertReference({
    path: filePath,
    hash,
    reference,
  }: Parameters<SearchIndex['upsertReference']>[0]) {
    transaction(() => {
      claimId({ id: reference.id, path: filePath })
      removeRowsForId(reference.id)
      run('DELETE FROM files WHERE path = ?', [filePath])
      run('INSERT INTO files(path, hash, kind, id) VALUES (?, ?, ?, ?)', [
        filePath,
        hash,
        'reference',
        reference.id,
      ])
      run(
        `INSERT INTO reference_docs(id, topic, title, description, scope, context, host, filetypes,
           tags, about, expires, expires_at, format, created, updated, source, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reference.id,
          reference.topic,
          reference.title,
          reference.description,
          reference.scope,
          reference.context ?? null,
          reference.host ?? null,
          JSON.stringify(reference.filetypes ?? []),
          JSON.stringify(reference.tags ?? []),
          JSON.stringify(reference.about ?? []),
          reference.expires ?? null,
          instantOf(reference.expires),
          reference.format,
          reference.created,
          reference.updated,
          reference.source,
          reference.content,
        ],
      )
      run('INSERT INTO reference_docs_fts(id, title, description, topic) VALUES (?, ?, ?, ?)', [
        reference.id,
        reference.title,
        reference.description,
        reference.topic,
      ])
      insertLabels(reference)
    })
  }

  function getReference(id: string): Reference | undefined {
    const row = one('SELECT * FROM reference_docs WHERE id = ?', [id])
    return row ? { ...toReferenceSummary(row), content: text(row, 'content') } : undefined
  }

  function findReferences(input: SearchFilter & { query?: string; limit: number }) {
    const clause = liveFilter(input)
    const match = input.query?.trim() ? toMatchQuery(input.query) : undefined
    if (input.query?.trim() && !match) return []
    if (match) {
      return all(
        `SELECT m.* FROM reference_docs_fts JOIN reference_docs m ON m.id = reference_docs_fts.id
         WHERE reference_docs_fts MATCH ? AND ${clause.sql}
         ORDER BY bm25(reference_docs_fts, 0, 2.0, 1.0, 0.5), m.id LIMIT ?`,
        [match, ...clause.params, input.limit],
      ).map(toReferenceSummary)
    }
    return all(
      `SELECT m.* FROM reference_docs m WHERE ${clause.sql} ORDER BY m.topic, m.title, m.id LIMIT ?`,
      [...clause.params, input.limit],
    ).map(toReferenceSummary)
  }

  function upsertCheckpoint({
    path: filePath,
    hash,
    checkpoint,
  }: Parameters<SearchIndex['upsertCheckpoint']>[0]) {
    transaction(() => {
      claimId({ id: checkpoint.id, path: filePath })
      const twin = one('SELECT id FROM checkpoints WHERE context = ? AND thread = ? AND id != ?', [
        checkpoint.context,
        checkpoint.thread,
        checkpoint.id,
      ])
      if (twin)
        throw new Error(`checkpoint for ${checkpoint.context}@${checkpoint.thread} already exists`)
      removeRowsForId(checkpoint.id)
      run('DELETE FROM files WHERE path = ?', [filePath])
      run('INSERT INTO files(path, hash, kind, id) VALUES (?, ?, ?, ?)', [
        filePath,
        hash,
        'checkpoint',
        checkpoint.id,
      ])
      run(
        `INSERT INTO checkpoints(id, context, thread, commit_hash, updated, source, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          checkpoint.id,
          checkpoint.context,
          checkpoint.thread,
          checkpoint.commit ?? null,
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
    const clause = liveFilter(filter)
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
    const clause = liveFilter(filter)
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

  /** The caller's own context and machine first; the order is otherwise kept. */
  function byLocalFirst(filter: SearchFilter, memories: Memory[]): Memory[] {
    if (filter.context === undefined && filter.host === undefined) return memories
    const isLocal = (memory: Memory) =>
      (filter.context !== undefined && memory.context === filter.context) ||
      (filter.host !== undefined && memory.host === filter.host)
    const rank = (memory: Memory) => (isLocal(memory) ? 0 : 1)
    return memories.toSorted((a, b) => rank(a) - rank(b))
  }

  /** Every match: rules for any file type first, then local, then topic and creation order. */
  function listMatching(input: SearchFilter): Memory[] {
    const clause = liveFilter(input)
    return all(
      `SELECT m.* FROM memories m WHERE ${clause.sql}
       ORDER BY
         CASE WHEN EXISTS (SELECT 1 FROM labels l WHERE l.id = m.id AND l.kind = 'filetype')
           THEN 1 ELSE 0 END,
         CASE WHEN m.context = ? OR m.host = ? THEN 0 ELSE 1 END,
         m.topic, m.created, m.id`,
      [...clause.params, input.context ?? null, input.host ?? null],
    ).map(toMemory)
  }

  function hybridSearch({
    query,
    topic,
    context,
    host,
    hostScopedOnly,
    filetypes,
    tags,
    about,
    kind,
    limit = CANDIDATES_PER_LIST,
    queryVector,
  }: SearchInput & { query: string }) {
    const filter = { topic, context, host, hostScopedOnly, filetypes, tags, about, kind }
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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .flatMap(([id]) => byId.get(id) ?? [])
    return byLocalFirst(filter, ranked).slice(0, limit)
  }

  function search(input: SearchInput): Memory[] {
    if (input.query?.trim()) return hybridSearch({ ...input, query: input.query })
    return listMatching(input)
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
      return kind === 'memory' || kind === 'reference' || kind === 'checkpoint' ? kind : undefined
    },
    getMemory,
    getCheckpoint(id) {
      const row = one('SELECT * FROM checkpoints WHERE id = ?', [id])
      return row ? toCheckpoint(row) : undefined
    },
    findCheckpoint(context, thread) {
      const row = one('SELECT * FROM checkpoints WHERE context = ? AND thread = ?', [
        context,
        thread,
      ])
      return row ? toCheckpoint(row) : undefined
    },
    listCheckpoints(context, thread) {
      const rows =
        thread === undefined
          ? all('SELECT * FROM checkpoints WHERE context = ? ORDER BY updated DESC, id', [context])
          : all('SELECT * FROM checkpoints WHERE context = ? AND thread = ?', [context, thread])
      return rows.map(toCheckpoint)
    },
    recentCheckpoints(limit) {
      return all('SELECT * FROM checkpoints ORDER BY updated DESC, id LIMIT ?', [limit]).map(
        toCheckpoint,
      )
    },
    upsertReference,
    getReference,
    findReferences,
    referenceTopicCounts() {
      const live = liveClause(moment())
      const rows = all(
        `SELECT topic, count(*) AS n FROM reference_docs m WHERE ${live.sql} GROUP BY topic`,
        live.params,
      )
      return new Map(rows.map((row) => [text(row, 'topic'), Number(row.n)]))
    },
    labelCounts() {
      // Memories only: these lines say what can be loaded, and references never are.
      const live = liveClause(moment())
      return all(
        `SELECT l.kind, l.value, count(*) AS n FROM labels l JOIN memories m ON m.id = l.id
         WHERE ${live.sql} GROUP BY l.kind, l.value ORDER BY l.kind, n DESC, l.value`,
        live.params,
      ).map((row) => ({ kind: text(row, 'kind'), value: text(row, 'value'), count: Number(row.n) }))
    },
    topicCounts() {
      const live = liveClause(moment())
      const rows = all(
        `SELECT topic, count(*) AS n FROM memories m WHERE ${live.sql} GROUP BY topic`,
        live.params,
      )
      return new Map(rows.map((row) => [text(row, 'topic'), Number(row.n)]))
    },
    contextMemoryCount(context) {
      const live = liveClause(moment())
      const row = one(
        `SELECT count(*) AS n FROM memories m WHERE scope = 'context' AND context = ? AND ${live.sql}`,
        [context, ...live.params],
      )
      return Number(row?.n ?? 0)
    },
    hostCounts() {
      const live = liveClause(moment())
      const rows = all(
        `SELECT host, count(*) AS n FROM memories m
         WHERE scope = 'host' AND host IS NOT NULL AND ${live.sql} GROUP BY host`,
        live.params,
      )
      return new Map(rows.map((row) => [text(row, 'host'), Number(row.n)]))
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
    expiredEntries() {
      const live = liveClause(moment())
      return all(
        `SELECT f.id AS id, f.path AS path FROM files f JOIN memories m ON m.id = f.id
           WHERE NOT ${live.sql}
         UNION ALL
         SELECT f.id AS id, f.path AS path FROM files f JOIN reference_docs m ON m.id = f.id
           WHERE NOT ${live.sql}
         ORDER BY id`,
        [...live.params, ...live.params],
      ).map((row) => ({ id: text(row, 'id'), path: text(row, 'path') }))
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
