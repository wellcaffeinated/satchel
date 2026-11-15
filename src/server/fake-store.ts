// In-memory Store for server tests. Mirrors the contract in src/types.ts, nothing more.
import {
  type Checkpoint,
  type CheckpointInput,
  type Host,
  type Labels,
  type MemorizeInput,
  type Memory,
  type RecallInput,
  SatchelError,
  type Store,
  type Topic,
} from '../types.ts'

const FIXED_TIME = '2026-11-12T18:04:00Z'

export interface FakeStoreSeed {
  core?: string
  topics?: Record<string, { trigger: string }>
  memories?: Memory[]
  checkpoints?: Checkpoint[]
}

export interface FakeStore extends Store {
  readonly recallLog: Array<{ id: string; client: string }>
  readonly memories: Map<string, Memory>
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

function checkpointKey(project: string, branch: string): string {
  return `${project}\u0000${branch}`
}

/** The matching rule from docs/design.md: every label field the memory sets must overlap. */
function matchesWork(memory: Memory, work: { filetypes?: string[]; tags?: string[] }): boolean {
  const field = (own: string[] | undefined, asked: string[] | undefined) =>
    !own?.length || own.some((value) => asked?.includes(value))
  const labelled = Boolean(memory.filetypes?.length || memory.tags?.length)
  return labelled && field(memory.filetypes, work.filetypes) && field(memory.tags, work.tags)
}

function matchesQuery(memory: Memory, query: string | undefined): boolean {
  if (query === undefined) return true
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.some((word) => memory.text.toLowerCase().includes(word))
}

export function createFakeStore(seed: FakeStoreSeed = {}): FakeStore {
  const coreText = seed.core ?? ''
  const triggers = new Map(Object.entries(seed.topics ?? {}).map(([n, t]) => [n, t.trigger]))
  const memories = new Map((seed.memories ?? []).map((m) => [m.id, m]))
  const checkpointsByKey = new Map(
    (seed.checkpoints ?? []).map((c) => [checkpointKey(c.project, c.branch), c]),
  )
  const recallLog: Array<{ id: string; client: string }> = []
  const nextMemoryId = idGenerator('m')
  const nextCheckpointId = idGenerator('c')
  const state = { closed: false }

  const countIn = (topic: string) => [...memories.values()].filter((m) => m.topic === topic).length

  const unknownTopic = (topic: string) =>
    new SatchelError(
      'unknown_topic',
      `Unknown topic "${topic}". Existing topics: ${[...triggers.keys()].join(', ')}. ` +
        'Pick one, or pass topic_trigger to create it.',
    )

  async function topics(): Promise<Topic[]> {
    const all = [...triggers].map(([name, trigger]) => ({ name, trigger, count: countIn(name) }))
    return all.toSorted((a, b) => b.count - a.count)
  }

  async function recall(input: RecallInput): Promise<Memory[]> {
    if (input.topic !== undefined && !triggers.has(input.topic)) throw unknownTopic(input.topic)
    const visible = (m: Memory) =>
      (m.scope !== 'project' || input.project === undefined || m.project === input.project) &&
      (m.scope !== 'host' || input.host === undefined || m.host === input.host)
    const labelled = input.filetypes !== undefined || input.tags !== undefined
    const hostOnly = input.host !== undefined && !input.query && !input.topic && !labelled
    return [...memories.values()]
      .filter((m) => input.topic === undefined || m.topic === input.topic)
      .filter((m) => matchesQuery(m, input.query))
      .filter(visible)
      .filter((m) => !hostOnly || m.scope === 'host')
      .filter((m) => !labelled || matchesWork(m, input))
  }

  async function logRecall(input: { ids: string[]; client: string }) {
    recallLog.push(...input.ids.map((id) => ({ id, client: input.client })))
  }

  async function labels(): Promise<Labels> {
    const counted = (values: string[]) =>
      [...Map.groupBy(values, (value) => value)]
        .map(([value, list]) => ({ value, count: list.length }))
        .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    const all = [...memories.values()]
    return {
      filetypes: counted(all.flatMap((m) => m.filetypes ?? [])),
      tags: counted(all.flatMap((m) => m.tags ?? [])),
    }
  }

  async function memorize(input: MemorizeInput) {
    if (!triggers.has(input.topic)) {
      if (!input.topicTrigger) throw unknownTopic(input.topic)
      triggers.set(input.topic, input.topicTrigger)
    }
    const previous = input.replaces ? memories.get(input.replaces) : undefined
    if (input.replaces && !previous) {
      throw new SatchelError('not_found', `No memory ${input.replaces}.`)
    }
    const memory: Memory = {
      id: previous?.id ?? nextMemoryId(),
      topic: input.topic,
      scope: input.scope ?? 'global',
      project: input.project,
      host: input.host,
      ...(input.filetypes?.length ? { filetypes: input.filetypes } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      created: previous?.created ?? FIXED_TIME,
      updated: FIXED_TIME,
      source: input.source,
      text: input.text,
    }
    const similar = [...memories.values()]
      .filter((m) => m.id !== memory.id && m.topic === memory.topic)
      .slice(0, 3)
    memories.set(memory.id, memory)
    return { memory, similar }
  }

  async function forget(id: string): Promise<void> {
    if (memories.delete(id)) return
    const key = [...checkpointsByKey].find(([, c]) => c.id === id)?.[0]
    if (key === undefined) throw new SatchelError('not_found', `No memory or checkpoint ${id}.`)
    checkpointsByKey.delete(key)
  }

  async function checkpoint(input: CheckpointInput): Promise<Checkpoint> {
    const key = checkpointKey(input.project, input.branch)
    const previous = checkpointsByKey.get(key)
    const saved: Checkpoint = {
      id: previous?.id ?? nextCheckpointId(),
      project: input.project,
      branch: input.branch,
      commit: input.commit,
      updated: FIXED_TIME,
      source: input.source,
      summary: input.summary ?? previous?.summary ?? '',
    }
    checkpointsByKey.set(key, saved)
    return saved
  }

  async function dropCheckpoint(project: string, branch: string): Promise<void> {
    checkpointsByKey.delete(checkpointKey(project, branch))
  }

  async function checkpoints(project: string, branch?: string): Promise<Checkpoint[]> {
    return [...checkpointsByKey.values()].filter(
      (c) => c.project === project && (branch === undefined || c.branch === branch),
    )
  }

  async function projectMemoryCount(project: string): Promise<number> {
    return [...memories.values()].filter((m) => m.scope === 'project' && m.project === project)
      .length
  }

  async function hosts(): Promise<Host[]> {
    const counts = Map.groupBy(
      [...memories.values()].filter((m) => m.scope === 'host' && m.host !== undefined),
      (m) => m.host ?? '',
    )
    return [...counts]
      .map(([name, list]) => ({ name, count: list.length }))
      .toSorted((a, b) => b.count - a.count)
  }

  return {
    recallLog,
    memories,
    checkpointsByKey,
    closed: () => state.closed,
    core: async () => coreText,
    topics,
    recall,
    logRecall,
    labels,
    memorize,
    forget,
    checkpoint,
    dropCheckpoint,
    checkpoints,
    projectMemoryCount,
    hosts,
    close: async () => {
      state.closed = true
    },
  }
}
