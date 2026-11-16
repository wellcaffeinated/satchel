// In-memory Store for server tests. Mirrors the contract in src/types.ts, nothing more.
import { DEFAULT_MEMORY_KIND, DEFAULT_MEMORY_ORIGIN } from '../config.ts'
import {
  type Checkpoint,
  type CheckpointInput,
  type Forgotten,
  type Host,
  type Labels,
  type MemorizeInput,
  type Memory,
  type RecallInput,
  type Reference,
  type ReferenceSummary,
  SatchelError,
  type SaveReferenceInput,
  type Store,
  type Topic,
} from '../types.ts'

const FIXED_TIME = '2026-11-12T18:04:00Z'
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface FakeStoreSeed {
  core?: string
  topics?: Record<string, { trigger: string }>
  memories?: Memory[]
  references?: Reference[]
  checkpoints?: Checkpoint[]
}

export interface FakeStore extends Store {
  readonly recallLog: Array<{ id: string; client: string }>
  readonly memories: Map<string, Memory>
  readonly references: Map<string, Reference>
  readonly checkpointsByKey: Map<string, Checkpoint>
  closed(): boolean
}

function idGenerator(prefix: string) {
  const counter = { value: 0 }
  return () => {
    counter.value += 1
    return `${prefix}_${String(counter.value).padStart(8, '0')}`
  }
}

function checkpointKey(context: string, thread: string): string {
  return `${context}\u0000${thread}`
}

type Labelled = { filetypes?: string[]; tags?: string[]; about?: string[] }

/** The matching rule from docs/design.md: every label field the memory sets must overlap. */
function matchesWork(memory: Labelled, work: Labelled): boolean {
  const field = (own: string[] | undefined, asked: string[] | undefined) =>
    !own?.length || own.some((value) => asked?.includes(value))
  const labelled = Boolean(memory.filetypes?.length || memory.tags?.length)
  return labelled && field(memory.filetypes, work.filetypes) && field(memory.tags, work.tags)
}

/** Any shared entity is a match. */
function matchesAbout(memory: Labelled, about: string[] | undefined): boolean {
  if (about === undefined) return true
  return (memory.about ?? []).some((value) => about.includes(value))
}

function matchesQuery(memory: Memory, query: string | undefined): boolean {
  if (query === undefined) return true
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.some((word) => memory.text.toLowerCase().includes(word))
}

/** As the real index: a day lasts through that day (UTC here), a timestamp until it passes. */
function isLive(entry: { expires?: string }): boolean {
  if (entry.expires === undefined) return true
  if (DAY.test(entry.expires)) return entry.expires >= FIXED_TIME.slice(0, 10)
  return new Date(entry.expires) > new Date(FIXED_TIME)
}

/** Present only when non-empty, as the real store keeps them. */
function listField<K extends string>(key: K, values: string[] | undefined) {
  return values?.length ? { [key]: values } : {}
}

/** The entries of a patch that were given at all; `null` counts, it clears a field. */
function given<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}

function requireField(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new SatchelError('invalid', `${name} must not be empty.`)
  }
  return value
}

export function createFakeStore(seed: FakeStoreSeed = {}): FakeStore {
  const coreText = seed.core ?? ''
  const triggers = new Map(Object.entries(seed.topics ?? {}).map(([n, t]) => [n, t.trigger]))
  const memories = new Map((seed.memories ?? []).map((m) => [m.id, m]))
  const references = new Map((seed.references ?? []).map((r) => [r.id, r]))
  const nextReferenceId = idGenerator('r')
  const checkpointsByKey = new Map(
    (seed.checkpoints ?? []).map((c) => [checkpointKey(c.context, c.thread), c]),
  )
  const recallLog: Array<{ id: string; client: string }> = []
  const nextMemoryId = idGenerator('m')
  const nextCheckpointId = idGenerator('c')
  const state = { closed: false }

  const live = () => [...memories.values()].filter(isLive)
  const countIn = (topic: string) => live().filter((m) => m.topic === topic).length

  const unknownTopic = (topic: string) =>
    new SatchelError(
      'unknown_topic',
      `Unknown topic "${topic}". Existing topics: ${[...triggers.keys()].join(', ')}. ` +
        'Pick one, or pass topic_trigger to create it.',
    )

  function ensureTopic(topic: string, trigger: string | undefined) {
    if (triggers.has(topic)) return
    if (!trigger) throw unknownTopic(topic)
    triggers.set(topic, trigger)
  }

  async function topics(): Promise<Topic[]> {
    const all = [...triggers].map(([name, trigger]) => ({ name, trigger, count: countIn(name) }))
    return all.toSorted((a, b) => b.count - a.count)
  }

  async function recall(input: RecallInput): Promise<Memory[]> {
    if (input.topic !== undefined && !triggers.has(input.topic)) throw unknownTopic(input.topic)
    const visible = (m: Memory) =>
      (m.scope !== 'context' || input.context === undefined || m.context === input.context) &&
      (m.scope !== 'host' || input.host === undefined || m.host === input.host)
    const labelled = input.filetypes !== undefined || input.tags !== undefined
    const hostOnly =
      input.host !== undefined &&
      !input.query &&
      !input.topic &&
      !labelled &&
      input.about === undefined
    return live()
      .filter((m) => input.topic === undefined || m.topic === input.topic)
      .filter((m) => input.kind === undefined || m.kind === input.kind)
      .filter((m) => matchesQuery(m, input.query))
      .filter(visible)
      .filter((m) => !hostOnly || m.scope === 'host')
      .filter((m) => !labelled || matchesWork(m, input))
      .filter((m) => matchesAbout(m, input.about))
  }

  async function findReferences(input: RecallInput): Promise<ReferenceSummary[]> {
    if (input.kind !== undefined) return []
    const labelled = input.filetypes !== undefined || input.tags !== undefined
    const words = input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const mentions = (r: Reference) =>
      words.length === 0 ||
      words.some((w) => `${r.title} ${r.description}`.toLowerCase().includes(w))
    return [...references.values()]
      .filter(isLive)
      .filter((r) => input.topic === undefined || r.topic === input.topic)
      .filter(mentions)
      .filter((r) => !labelled || matchesWork(r, input))
      .filter((r) => matchesAbout(r, input.about))
      .map(({ content: _content, ...summary }) => summary)
  }

  function referenceAsInput(reference: Reference): Omit<SaveReferenceInput, 'source'> {
    const { id: _id, created: _created, updated: _updated, source: _source, ...rest } = reference
    return rest
  }

  async function saveReference(input: SaveReferenceInput): Promise<Reference> {
    const previous = input.replaces ? references.get(input.replaces) : undefined
    if (input.replaces && !previous) {
      throw new SatchelError('not_found', `No reference ${input.replaces}.`)
    }
    const merged = previous ? { ...referenceAsInput(previous), ...given(input) } : input
    const topic = requireField(merged.topic, 'topic')
    ensureTopic(topic, merged.topicTrigger)
    const reference: Reference = {
      id: previous?.id ?? nextReferenceId(),
      topic,
      title: requireField(merged.title, 'title'),
      description: requireField(merged.description, 'description'),
      scope: merged.scope ?? 'global',
      ...(merged.scope === 'context' ? { context: merged.context } : {}),
      ...(merged.scope === 'host' ? { host: merged.host } : {}),
      ...listField('filetypes', merged.filetypes),
      ...listField('tags', merged.tags),
      ...listField('about', merged.about),
      ...(merged.expires ? { expires: merged.expires } : {}),
      format: merged.format ?? 'markdown',
      created: previous?.created ?? FIXED_TIME,
      updated: FIXED_TIME,
      source: input.source,
      content: requireField(merged.content, 'content'),
    }
    references.set(reference.id, reference)
    return reference
  }

  async function read(id: string) {
    const memory = memories.get(id)
    if (memory) return { kind: 'memory' as const, memory }
    const reference = references.get(id)
    if (reference) return { kind: 'reference' as const, reference }
    throw new SatchelError('not_found', `No memory or reference ${id}.`)
  }

  async function logRecall(input: { ids: string[]; client: string }) {
    recallLog.push(...input.ids.map((id) => ({ id, client: input.client })))
  }

  async function labels(): Promise<Labels> {
    const counted = (values: string[]) =>
      [...Map.groupBy(values, (value) => value)]
        .map(([value, list]) => ({ value, count: list.length }))
        .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    const all = live()
    return {
      filetypes: counted(all.flatMap((m) => m.filetypes ?? [])),
      tags: counted(all.flatMap((m) => m.tags ?? [])),
      about: counted(all.flatMap((m) => m.about ?? [])),
    }
  }

  function memoryAsInput(memory: Memory): Omit<MemorizeInput, 'source'> {
    const { id: _id, created: _created, updated: _updated, source: _source, ...rest } = memory
    return rest
  }

  async function memorize(input: MemorizeInput) {
    const previous = input.replaces ? memories.get(input.replaces) : undefined
    if (input.replaces && !previous) {
      throw new SatchelError('not_found', `No memory ${input.replaces}.`)
    }
    const merged = previous ? { ...memoryAsInput(previous), ...given(input) } : input
    const topic = requireField(merged.topic, 'topic')
    ensureTopic(topic, merged.topicTrigger)
    const kind = merged.kind ?? DEFAULT_MEMORY_KIND
    if (kind === 'event' && !merged.date) {
      throw new SatchelError('invalid', 'kind "event" needs `date` (YYYY-MM-DD).')
    }
    const memory: Memory = {
      id: previous?.id ?? nextMemoryId(),
      topic,
      kind,
      origin: merged.origin ?? DEFAULT_MEMORY_ORIGIN,
      ...(merged.date ? { date: merged.date } : {}),
      ...(merged.expires ? { expires: merged.expires } : {}),
      scope: merged.scope ?? 'global',
      ...(merged.scope === 'context' ? { context: merged.context } : {}),
      ...(merged.scope === 'host' ? { host: merged.host } : {}),
      ...listField('filetypes', merged.filetypes),
      ...listField('tags', merged.tags),
      ...listField('about', merged.about),
      created: previous?.created ?? FIXED_TIME,
      updated: FIXED_TIME,
      source: input.source,
      text: requireField(merged.text, 'text'),
    }
    const similar = live()
      .filter((m) => m.id !== memory.id && m.topic === memory.topic)
      .slice(0, 3)
    memories.set(memory.id, memory)
    return { memory, similar }
  }

  async function forget(id: string): Promise<Forgotten> {
    const memory = memories.get(id)
    if (memory) {
      memories.delete(id)
      return { kind: 'memory', memory }
    }
    const reference = references.get(id)
    if (reference) {
      references.delete(id)
      return { kind: 'reference', reference }
    }
    const found = [...checkpointsByKey].find(([, c]) => c.id === id)
    if (found === undefined) throw new SatchelError('not_found', `No memory or checkpoint ${id}.`)
    checkpointsByKey.delete(found[0])
    return { kind: 'checkpoint', checkpoint: found[1] }
  }

  async function checkpoint(input: CheckpointInput): Promise<Checkpoint> {
    const key = checkpointKey(input.context, input.thread)
    const previous = checkpointsByKey.get(key)
    const commit = input.commit ?? previous?.commit
    const saved: Checkpoint = {
      id: previous?.id ?? nextCheckpointId(),
      context: input.context,
      thread: input.thread,
      ...(commit ? { commit } : {}),
      updated: FIXED_TIME,
      source: input.source,
      summary: input.summary ?? previous?.summary ?? '',
    }
    checkpointsByKey.set(key, saved)
    return saved
  }

  async function dropCheckpoint(context: string, thread: string): Promise<void> {
    checkpointsByKey.delete(checkpointKey(context, thread))
  }

  async function checkpoints(context: string, thread?: string): Promise<Checkpoint[]> {
    return [...checkpointsByKey.values()].filter(
      (c) => c.context === context && (thread === undefined || c.thread === thread),
    )
  }

  async function recentCheckpoints(limit: number): Promise<Checkpoint[]> {
    return [...checkpointsByKey.values()]
      .toSorted((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id))
      .slice(0, limit)
  }

  async function contextMemoryCount(context: string): Promise<number> {
    return live().filter((m) => m.scope === 'context' && m.context === context).length
  }

  async function hosts(): Promise<Host[]> {
    const counts = Map.groupBy(
      live().filter((m) => m.scope === 'host' && m.host !== undefined),
      (m) => m.host ?? '',
    )
    return [...counts]
      .map(([name, list]) => ({ name, count: list.length }))
      .toSorted((a, b) => b.count - a.count)
  }

  return {
    recallLog,
    memories,
    references,
    checkpointsByKey,
    closed: () => state.closed,
    core: async () => coreText,
    topics,
    recall,
    findReferences,
    saveReference,
    read,
    logRecall,
    labels,
    memorize,
    forget,
    checkpoint,
    dropCheckpoint,
    checkpoints,
    recentCheckpoints,
    contextMemoryCount,
    hosts,
    close: async () => {
      state.closed = true
    },
  }
}
