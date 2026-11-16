import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CORE_MAX_CHARS, REFERENCES_LISTED_MAX } from '../config.ts'
import { createHuggingFaceLoader, type EmbedderLoader } from '../embed/index.ts'
import { createSearchIndex, hashText, type SearchIndex } from '../index/index.ts'
import { log } from '../log.ts'
import {
  type Checkpoint,
  type CheckpointInput,
  type Host,
  type Labels,
  type MemorizeInput,
  type MemorizeResult,
  type Memory,
  type RecallInput,
  type Reference,
  type ReferenceSummary,
  SatchelError,
  type SaveReferenceInput,
  type Store,
  type Topic,
} from '../types.ts'
import { createEmbeddingWorker } from './embedding-worker.ts'
import { createGitRepo } from './git-repo.ts'
import {
  hashContent,
  leadParagraph,
  randomId,
  renderCheckpoint,
  renderMemory,
  renderReference,
} from './memory-files.ts'
import { type ScannedFile, scanRepo } from './repo-scan.ts'
import { createRepoWatcher } from './repo-watcher.ts'
import { safePathSegment, slugifyBody } from './slug.ts'
import { formatTimestamp } from './time.ts'
import { createTopicsFile } from './topics-file.ts'
import {
  cleanClientName,
  validateCheckpoint,
  validateMemorize,
  validateReference,
} from './validation.ts'
import { createWriteQueue } from './write-queue.ts'

const WATCH_DEBOUNCE_MS = 200
const SIMILAR_LIMIT = 3

export interface StoreOptions {
  dataDir: string
  /** Hugging Face model id, or "off". */
  embedModel: string
  /** Replaces the Hugging Face loader; used by tests. */
  embedderLoader?: EmbedderLoader
  now?: () => Date
  watchDebounceMs?: number
}

export interface SatchelStore extends Store {
  /** Rescans the repo files now (the watcher does this on its own, debounced). */
  sync(): Promise<void>
  /** Resolves when the embedding model load has settled and background embedding is done. */
  embeddingsIdle(): Promise<void>
  /** Where the search index lives, for diagnostics. */
  readonly indexPath: string
}

function undefinedIfEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function checkpointPath(context: string, thread: string): string {
  return `checkpoints/${safePathSegment(context)}/${safePathSegment(thread)}.md`
}

/** A recall request as the index takes it: trimmed names, and what "nothing asked" means. */
function searchRequest(input: RecallInput) {
  const query = undefinedIfEmpty(input.query)
  const topic = undefinedIfEmpty(input.topic)
  const host = undefinedIfEmpty(input.host)
  const { filetypes, tags, about, kind } = input
  const labelled = filetypes !== undefined || tags !== undefined || about !== undefined
  return {
    query,
    topic,
    project: undefinedIfEmpty(input.project),
    host,
    // A host on its own asks what is known about that machine, not for everything.
    hostScopedOnly: query === undefined && topic === undefined && !labelled,
    filetypes,
    tags,
    about,
    kind,
    asked: query !== undefined || topic !== undefined || host !== undefined || labelled,
  }
}

export async function createStore(options: StoreOptions): Promise<SatchelStore> {
  const {
    dataDir,
    embedModel,
    now = () => new Date(),
    watchDebounceMs = WATCH_DEBOUNCE_MS,
  } = options
  const repoDir = join(dataDir, 'repo')
  const indexPath = join(dataDir, 'index.sqlite')

  await mkdir(dataDir, { recursive: true })
  const repo = createGitRepo({ dir: repoDir })
  await repo.ensureInitialised()

  const index: SearchIndex = createSearchIndex({ path: indexPath, now })
  const queue = createWriteQueue()
  const topicsFile = createTopicsFile({ path: join(repoDir, 'topics.yaml') })
  const loader =
    embedModel === 'off'
      ? undefined
      : (options.embedderLoader ??
        createHuggingFaceLoader({ model: embedModel, cacheDir: join(dataDir, 'models') }))
  const worker = createEmbeddingWorker({ index, model: embedModel, loader })
  const warnedHashes = new Map<string, string>()

  // ---- files and git ------------------------------------------------------------------

  async function writeRepoFile(path: string, content: string) {
    const target = join(repoDir, path)
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temporary, content)
    await rename(temporary, target)
  }

  async function removeRepoFile(path: string) {
    await rm(join(repoDir, path), { force: true })
  }

  function commitMessage(action: string, subject: string, source: string): string {
    return `${action}: ${subject} (via ${source})`
  }

  function newId(prefix: 'm' | 'c' | 'r'): string {
    const id = randomId(prefix, randomBytes(8))
    return index.pathOfId(id) === undefined ? id : newId(prefix)
  }

  // ---- reconciling the index with the files ---------------------------------------------

  function warnOnce(file: ScannedFile, message: string, error: string) {
    if (warnedHashes.get(file.path) === file.hash) return
    warnedHashes.set(file.path, file.hash)
    log.warn(message, { path: file.path, error })
  }

  function indexFile(file: ScannedFile) {
    const indexers = {
      memory: (f: Extract<ScannedFile, { kind: 'memory' }>) =>
        index.upsertMemory({ path: f.path, hash: f.hash, memory: f.memory }),
      reference: (f: Extract<ScannedFile, { kind: 'reference' }>) =>
        index.upsertReference({ path: f.path, hash: f.hash, reference: f.reference }),
      checkpoint: (f: Extract<ScannedFile, { kind: 'checkpoint' }>) =>
        index.upsertCheckpoint({ path: f.path, hash: f.hash, checkpoint: f.checkpoint }),
      malformed: (f: Extract<ScannedFile, { kind: 'malformed' }>) => {
        index.deleteByPath(f.path)
        warnOnce(f, 'skipping malformed file', f.error)
      },
    }
    try {
      if (file.kind === 'memory') return indexers.memory(file)
      if (file.kind === 'reference') return indexers.reference(file)
      if (file.kind === 'checkpoint') return indexers.checkpoint(file)
      return indexers.malformed(file)
    } catch (error) {
      index.deleteByPath(file.path)
      warnOnce(file, 'skipping unindexable file', String(error))
    }
  }

  async function reconcile() {
    const scanned = await scanRepo(repoDir)
    const present = new Set(scanned.map((file) => file.path))
    const known = index.fileHashes()
    for (const path of known.keys()) {
      if (!present.has(path)) index.deleteByPath(path)
    }
    for (const file of scanned.filter(
      (candidate) => known.get(candidate.path) !== candidate.hash,
    )) {
      indexFile(file)
    }
    worker.kick()
  }

  const sync = () => queue.run(reconcile)

  // ---- reads ----------------------------------------------------------------------------

  async function core(): Promise<string> {
    const raw = await readFile(join(repoDir, 'core.md'), 'utf8').catch(() => '')
    return raw.slice(0, CORE_MAX_CHARS)
  }

  async function topics(): Promise<Topic[]> {
    const triggers = await topicsFile.read()
    const counts = index.topicCounts()
    const referenceCounts = index.referenceTopicCounts()
    const names = new Set([...triggers.keys(), ...counts.keys(), ...referenceCounts.keys()])
    const topicOf = (name: string) => {
      const references = referenceCounts.get(name) ?? 0
      return {
        name,
        trigger: triggers.get(name) ?? '',
        count: counts.get(name) ?? 0,
        ...(references === 0 ? {} : { references }),
      }
    }
    return [...names].map(topicOf).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  async function hosts(): Promise<Host[]> {
    return [...index.hostCounts()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  async function recall(input: RecallInput): Promise<Memory[]> {
    const { asked, ...request } = searchRequest(input)
    if (!asked) {
      throw new SatchelError(
        'invalid',
        'recall needs a query, a topic, a host, filetypes, tags or about.',
      )
    }
    const queryVector =
      request.query === undefined ? undefined : await worker.queryVector(request.query)
    return index.search({ ...request, queryVector })
  }

  async function findReferences(input: RecallInput): Promise<ReferenceSummary[]> {
    const { asked: _asked, kind: _kind, ...request } = searchRequest(input)
    return index.findReferences({ ...request, limit: REFERENCES_LISTED_MAX })
  }

  async function read(id: string) {
    const memory = index.getMemory(id)
    if (memory) return { kind: 'memory' as const, memory }
    const reference = index.getReference(id)
    if (reference) return { kind: 'reference' as const, reference }
    throw new SatchelError('not_found', `No memory or reference with id "${id}".`)
  }

  async function logRecall(input: { ids: string[]; client: string }) {
    if (input.ids.length === 0) return
    index.logRecall({ ids: input.ids, client: cleanClientName(input.client) })
  }

  async function labels(): Promise<Labels> {
    const counts = index.labelCounts()
    const ofKind = (kind: string) =>
      counts
        .filter((entry) => entry.kind === kind)
        .map((entry) => ({ value: entry.value, count: entry.count }))
    return { filetypes: ofKind('filetype'), tags: ofKind('tag'), about: ofKind('about') }
  }

  // ---- writes ---------------------------------------------------------------------------

  async function unknownTopicError(name: string): Promise<SatchelError> {
    const names = (await topics()).map((topic) => topic.name)
    const known = names.length > 0 ? names.join(', ') : '(none yet)'
    return new SatchelError(
      'unknown_topic',
      `Unknown topic "${name}". Existing topics: ${known}. Use one of them, or pass topic_trigger to create it.`,
    )
  }

  function requireMemory(id: string): Memory {
    const memory = index.getMemory(id)
    if (!memory) throw new SatchelError('not_found', `No memory with id "${id}".`)
    return memory
  }

  async function memorizeLocked(input: MemorizeInput): Promise<MemorizeResult> {
    const replaced = input.replaces === undefined ? undefined : requireMemory(input.replaces)
    const fields = validateMemorize(input, replaced)
    const source = cleanClientName(input.source)
    const knownTopics = await topicsFile.read()
    const createsTopic = !knownTopics.has(fields.topic)
    if (createsTopic && fields.topicTrigger === undefined)
      throw await unknownTopicError(fields.topic)

    const timestamp = formatTimestamp(now())
    const id = replaced?.id ?? newId('m')
    const memory: Memory = {
      id,
      topic: fields.topic,
      kind: fields.kind,
      origin: fields.origin,
      ...(fields.date === undefined ? {} : { date: fields.date }),
      ...(fields.expires === undefined ? {} : { expires: fields.expires }),
      scope: fields.scope,
      ...(fields.project === undefined ? {} : { project: fields.project }),
      ...(fields.host === undefined ? {} : { host: fields.host }),
      ...(fields.filetypes === undefined ? {} : { filetypes: fields.filetypes }),
      ...(fields.tags === undefined ? {} : { tags: fields.tags }),
      ...(fields.about === undefined ? {} : { about: fields.about }),
      created: replaced?.created ?? timestamp,
      updated: timestamp,
      source,
      text: fields.text,
    }
    const oldPath = replaced ? index.pathOfId(id) : undefined
    const keepsPath =
      replaced !== undefined && replaced.topic === fields.topic && oldPath !== undefined
    const path = keepsPath
      ? oldPath
      : `memories/${fields.topic}/${slugifyBody(fields.text)}-${id}.md`
    const content = renderMemory(memory)
    const changed = [path]

    await writeRepoFile(path, content)
    if (oldPath !== undefined && oldPath !== path) index.deleteByPath(oldPath)
    index.upsertMemory({ path, hash: hashContent(content), memory })
    if (oldPath !== undefined && oldPath !== path) {
      await removeRepoFile(oldPath)
      changed.push(oldPath)
    }
    if (createsTopic && fields.topicTrigger !== undefined) {
      await writeRepoFile(
        'topics.yaml',
        await topicsFile.withTopic({ name: fields.topic, trigger: fields.topicTrigger }),
      )
      changed.push('topics.yaml')
    }
    await repo.commit({
      paths: changed,
      message: commitMessage(replaced ? 'update' : 'memorize', `${id} in ${fields.topic}`, source),
    })

    const rule = leadParagraph(fields.text)
    const vector = await worker.passageVector(rule)
    if (vector)
      index.setVector({
        id,
        model: vector.model,
        textHash: hashText(fields.text),
        vector: vector.vector,
      })
    worker.kick()
    const similar = index.similar({
      text: rule,
      excludeId: id,
      limit: SIMILAR_LIMIT,
      vector,
    })
    return { memory, similar }
  }

  /** Creates the topic in topics.yaml when needed; returns the paths it changed. */
  async function ensureTopic(name: string, trigger: string | undefined): Promise<string[]> {
    const knownTopics = await topicsFile.read()
    if (knownTopics.has(name)) return []
    if (trigger === undefined) throw await unknownTopicError(name)
    await writeRepoFile('topics.yaml', await topicsFile.withTopic({ name, trigger }))
    return ['topics.yaml']
  }

  function requireReference(id: string): Reference {
    const reference = index.getReference(id)
    if (!reference) throw new SatchelError('not_found', `No reference with id "${id}".`)
    return reference
  }

  async function saveReferenceLocked(input: SaveReferenceInput): Promise<Reference> {
    const replaced = input.replaces === undefined ? undefined : requireReference(input.replaces)
    const fields = validateReference(input, replaced)
    const source = cleanClientName(input.source)
    const topicPaths = await ensureTopic(fields.topic, fields.topicTrigger)
    const timestamp = formatTimestamp(now())
    const id = replaced?.id ?? newId('r')
    const reference: Reference = {
      id,
      topic: fields.topic,
      title: fields.title,
      description: fields.description,
      scope: fields.scope,
      ...(fields.project === undefined ? {} : { project: fields.project }),
      ...(fields.host === undefined ? {} : { host: fields.host }),
      ...(fields.filetypes === undefined ? {} : { filetypes: fields.filetypes }),
      ...(fields.tags === undefined ? {} : { tags: fields.tags }),
      ...(fields.about === undefined ? {} : { about: fields.about }),
      ...(fields.expires === undefined ? {} : { expires: fields.expires }),
      format: fields.format,
      created: replaced?.created ?? timestamp,
      updated: timestamp,
      source,
      content: fields.content,
    }
    const oldPath = replaced ? index.pathOfId(id) : undefined
    const path = `references/${fields.topic}/${slugifyBody(fields.title)}-${id}.md`
    const content = renderReference(reference)
    await writeRepoFile(path, content)
    if (oldPath !== undefined && oldPath !== path) {
      index.deleteByPath(oldPath)
      await removeRepoFile(oldPath)
    }
    index.upsertReference({ path, hash: hashContent(content), reference })
    const moved = oldPath !== undefined && oldPath !== path ? [oldPath] : []
    await repo.commit({
      paths: [path, ...moved, ...topicPaths],
      message: commitMessage(replaced ? 'update' : 'reference', `${id} in ${fields.topic}`, source),
    })
    return reference
  }

  async function forgetLocked(id: string, rawSource: string) {
    const path = index.pathOfId(id)
    if (path === undefined)
      throw new SatchelError('not_found', `No memory or checkpoint with id "${id}".`)
    await removeRepoFile(path)
    index.deleteByPath(path)
    await repo.commit({
      paths: [path],
      message: commitMessage('forget', id, cleanClientName(rawSource)),
    })
  }

  async function checkpointLocked(input: CheckpointInput): Promise<Checkpoint> {
    const fields = validateCheckpoint(input)
    const source = cleanClientName(input.source)
    const existing = index.findCheckpoint(fields.context, fields.thread)
    const commit = undefinedIfEmpty(fields.commit ?? existing?.commit)
    const checkpoint: Checkpoint = {
      id: existing?.id ?? newId('c'),
      context: fields.context,
      thread: fields.thread,
      ...(commit === undefined ? {} : { commit }),
      updated: formatTimestamp(now()),
      source,
      summary: fields.summary ?? existing?.summary ?? '',
    }
    const path =
      (existing ? index.pathOfId(existing.id) : undefined) ??
      checkpointPath(fields.context, fields.thread)
    const content = renderCheckpoint(checkpoint)
    await writeRepoFile(path, content)
    index.upsertCheckpoint({ path, hash: hashContent(content), checkpoint })
    await repo.commit({
      paths: [path],
      message: commitMessage('checkpoint', `${fields.context} @ ${fields.thread}`, source),
    })
    return checkpoint
  }

  async function dropCheckpointLocked(context: string, thread: string, rawSource: string) {
    const existing = index.findCheckpoint(context, thread)
    if (!existing) return
    await forgetLocked(existing.id, rawSource)
  }

  // ---- lifecycle ------------------------------------------------------------------------

  await queue.run(reconcile)
  const watcher = createRepoWatcher({
    dir: repoDir,
    debounceMs: watchDebounceMs,
    onChange: () => {
      if (queue.isClosed()) return
      queue.run(reconcile).catch((error) => log.warn('rescan failed', { error: String(error) }))
    },
  })
  worker.start()

  async function close() {
    watcher.close()
    await queue.close()
    await worker.stop()
    index.close()
  }

  return {
    indexPath,
    core,
    topics,
    recall,
    findReferences,
    read,
    saveReference: (input) => queue.run(() => saveReferenceLocked(input)),
    logRecall,
    labels,
    memorize: (input) => queue.run(() => memorizeLocked(input)),
    forget: (id, source) => queue.run(() => forgetLocked(id, source)),
    checkpoint: (input) => queue.run(() => checkpointLocked(input)),
    dropCheckpoint: (context, thread, source) =>
      queue.run(() => dropCheckpointLocked(context, thread, source)),
    checkpoints: async (context, thread) => index.listCheckpoints(context, thread),
    recentCheckpoints: async (limit) => index.recentCheckpoints(limit),
    projectMemoryCount: async (project) => index.projectMemoryCount(project),
    hosts,
    sync,
    embeddingsIdle: () => worker.whenIdle(),
    close,
  }
}
