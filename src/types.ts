// Shared types and the seam between storage and the server.
// See docs/design.md. server/ depends on Store only, never on store/ internals.

export type Scope = 'global' | 'project' | 'host'

export interface Memory {
  id: string // "m_" + 8 base32 chars
  topic: string
  scope: Scope
  project?: string // set when scope is "project"
  host?: string // set when scope is "host"
  filetypes?: string[] // extensions without the dot; absent when empty
  tags?: string[] // lowercase kebab-case labels; absent when empty
  created: string // ISO 8601 UTC
  updated: string
  source: string // client name of the writer
  text: string
}

export interface Checkpoint {
  id: string // "c_" + 8 base32 chars
  project: string
  branch: string
  commit: string
  updated: string
  source: string
  summary: string // may be empty
}

export interface Topic {
  name: string
  trigger: string
  count: number // memories in this topic
}

/** A machine that has host-scoped memories. */
export interface Host {
  name: string
  count: number // host-scoped memories for this machine
}

export interface MemorizeInput {
  text: string
  topic: string
  scope?: Scope // default "global"
  project?: string
  host?: string
  filetypes?: string[]
  tags?: string[]
  topicTrigger?: string // required when the topic does not exist yet
  replaces?: string // id of a memory to rewrite in place
  source: string
}

export interface MemorizeResult {
  memory: Memory
  similar: Memory[] // up to 3 existing memories close to the new one, excluding itself
}

export interface RecallInput {
  query?: string
  topic?: string
  project?: string
  /**
   * The caller's machine: its host-scoped memories rank first and other machines' are hidden.
   * Given without query or topic, lists that machine's host-scoped memories.
   */
  host?: string
  limit?: number // default 8, max 25
  client: string // for the recall log
}

export interface CheckpointInput {
  project: string
  branch: string
  commit: string
  summary?: string // undefined keeps the existing summary
  source: string
}

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
  /** All topics with counts, most-used first. */
  topics(): Promise<Topic[]>
  recall(input: RecallInput): Promise<Memory[]>
  memorize(input: MemorizeInput): Promise<MemorizeResult>
  /** Deletes a memory or checkpoint by id. Throws SatchelError("not_found"). */
  forget(id: string, source: string): Promise<void>
  checkpoint(input: CheckpointInput): Promise<Checkpoint>
  /** Removes the checkpoint for a branch; no error when there is none. */
  dropCheckpoint(project: string, branch: string, source: string): Promise<void>
  /** Checkpoints of a project; one entry when branch is given and exists. */
  checkpoints(project: string, branch?: string): Promise<Checkpoint[]>
  /** Number of project-scoped memories for a project. */
  projectMemoryCount(project: string): Promise<number>
  /** Machines that have host-scoped memories, most memories first. */
  hosts(): Promise<Host[]>
  close(): Promise<void>
}
