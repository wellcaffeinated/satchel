// Shared types and the seam between storage and the server.
// See docs/design.md. server/ depends on Store only, never on store/ internals.

/** Where a memory holds: everywhere, in one context (a repository or an undertaking), or on one machine. */
export type Scope = 'global' | 'context' | 'host'

/** What sort of thing a memory states. See docs/design.md "Kind, origin, dates and about". */
export type MemoryKind = 'rule' | 'fact' | 'event' | 'preference'

/** Where a memory came from: the owner's words, the agent's conclusion, or another system. */
export type MemoryOrigin = 'stated' | 'inferred' | 'imported'

export interface Memory {
  id: string // "m_" + 8 base32 chars
  topic: string
  kind: MemoryKind
  origin: MemoryOrigin
  date?: string // the day an event happened or will happen; ISO 8601
  expires?: string // after this the memory no longer applies; ISO 8601
  about?: string[] // entities the memory concerns, "name" or "kind:name"; absent when empty
  scope: Scope
  context?: string // set when scope is "context": a project id or an undertaking
  host?: string // set when scope is "host"
  filetypes?: string[] // extensions without the dot; absent when empty
  tags?: string[] // lowercase kebab-case labels; absent when empty
  created: string // ISO 8601 UTC
  updated: string
  source: string // client name of the writer
  text: string
}

/** Verbatim material an agent consults or copies, found by title and description. */
export interface Reference {
  id: string // "r_" + 8 base32 chars
  topic: string
  title: string
  description: string // one line
  scope: Scope
  context?: string
  host?: string
  filetypes?: string[]
  tags?: string[]
  about?: string[]
  expires?: string
  format: string // the content's language, e.g. "jsonc"; "markdown" is stored unfenced
  created: string
  updated: string
  source: string
  content: string
}

/** A reference without its content, as listings show it. */
export type ReferenceSummary = Omit<Reference, 'content'>

/**
 * Fields of a save. With `replaces`, every field left undefined keeps its stored value, so
 * the required ones are only required for a new reference. `null` clears `expires`; an empty
 * list clears a label list.
 */
export interface SaveReferenceInput {
  title?: string
  description?: string
  content?: string
  format?: string // default "markdown"
  topic?: string
  scope?: Scope
  context?: string
  host?: string
  filetypes?: string[]
  tags?: string[]
  about?: string[]
  expires?: string | null
  topicTrigger?: string
  replaces?: string // id of a reference to update in place
  source: string
}

/** Where work left off on one thread of one context. See docs/design.md. */
export interface Checkpoint {
  id: string // "c_" + 8 base32 chars
  context: string // a project id, or any undertaking
  thread: string // a branch, or "main"
  commit?: string // only code threads have one
  updated: string
  source: string
  summary: string // may be empty
}

export interface Topic {
  name: string
  trigger: string
  count: number // memories in this topic
  references?: number // references in this topic, when any
}

/** A machine that has host-scoped memories. */
export interface Host {
  name: string
  count: number // host-scoped memories for this machine
}

/**
 * Fields of a save. With `replaces`, every field left undefined keeps its stored value, so
 * `text` and `topic` are only required for a new memory. `null` clears `date` or `expires`;
 * an empty list clears a label list.
 */
export interface MemorizeInput {
  text?: string
  topic?: string
  kind?: MemoryKind // default "fact"
  origin?: MemoryOrigin // default "inferred"
  date?: string | null
  expires?: string | null
  about?: string[]
  scope?: Scope // default "global"
  context?: string
  host?: string
  filetypes?: string[]
  tags?: string[]
  topicTrigger?: string // required when the topic does not exist yet
  replaces?: string // id of a memory to update in place
  source: string
}

export interface MemorizeResult {
  memory: Memory
  similar: Memory[] // up to 3 existing memories close to the new one, excluding itself
}

export interface RecallInput {
  query?: string
  topic?: string
  /** The caller's context: its context-scoped memories rank first and other contexts' are hidden. */
  context?: string
  /**
   * The caller's machine: its host-scoped memories rank first and other machines' are hidden.
   * Given without query or topic, lists that machine's host-scoped memories.
   */
  host?: string
  /** Labels of the work at hand: memories match when every label field they set overlaps. */
  filetypes?: string[]
  tags?: string[]
  /** Entities: memories match when they carry any of these. */
  about?: string[]
  /** Keeps only memories of this kind. */
  kind?: MemoryKind
}

/** How many memories carry one label value. */
export interface LabelCount {
  value: string
  count: number
}

export interface Labels {
  filetypes: LabelCount[]
  tags: LabelCount[]
  about: LabelCount[]
}

export interface CheckpointInput {
  context: string
  thread: string
  commit?: string // undefined keeps the existing commit; empty string clears it
  summary?: string // undefined keeps the existing summary
  source: string
}

/** What `forget` removed, so the caller can say what went. */
export type Forgotten =
  | { kind: 'memory'; memory: Memory }
  | { kind: 'reference'; reference: ReferenceSummary }
  | { kind: 'checkpoint'; checkpoint: Checkpoint }

/** Thrown by Store for caller mistakes; the message is safe to show to a model. */
export class SatchelError extends Error {
  readonly code: 'unknown_topic' | 'not_found' | 'invalid' | 'too_long'
  constructor(code: SatchelError['code'], message: string) {
    super(message)
    this.name = 'SatchelError'
    this.code = code
  }
}

export interface Store {
  /** Contents of core.md, already capped. */
  core(): Promise<string>
  /** All topics with counts, most-used first. Expired memories are not counted. */
  topics(): Promise<Topic[]>
  /**
   * Every live match, in the order docs/design.md "Paging" sets: by relevance for a query
   * (at most the search candidates), otherwise all matching memories. Paging is the caller's.
   */
  recall(input: RecallInput): Promise<Memory[]>
  /** Records that these memories were shown to a client. */
  logRecall(input: { ids: string[]; client: string }): Promise<void>
  /** Every label used by a live memory, most used first. */
  labels(): Promise<Labels>
  /** References matching a recall request, without content; at most REFERENCES_LISTED_MAX. */
  findReferences(input: RecallInput): Promise<ReferenceSummary[]>
  saveReference(input: SaveReferenceInput): Promise<Reference>
  /** A memory or reference by id, expired or not. Throws SatchelError("not_found"). */
  read(
    id: string,
  ): Promise<{ kind: 'memory'; memory: Memory } | { kind: 'reference'; reference: Reference }>
  memorize(input: MemorizeInput): Promise<MemorizeResult>
  /** Deletes a memory, reference or checkpoint by id. Throws SatchelError("not_found"). */
  forget(id: string, source: string): Promise<Forgotten>
  checkpoint(input: CheckpointInput): Promise<Checkpoint>
  /** Removes the checkpoint for a thread; no error when there is none. */
  dropCheckpoint(context: string, thread: string, source: string): Promise<void>
  /** Checkpoints of a context, most recently updated first; one entry when thread is given and exists. */
  checkpoints(context: string, thread?: string): Promise<Checkpoint[]>
  /** The most recently updated checkpoints across every context. */
  recentCheckpoints(limit: number): Promise<Checkpoint[]>
  /** Number of live context-scoped memories of a context. */
  contextMemoryCount(context: string): Promise<number>
  /** Machines that have host-scoped memories, most memories first. */
  hosts(): Promise<Host[]>
  close(): Promise<void>
}
