// The operations behind the MCP tools. Each returns the text a model reads
// and throws SatchelError for caller mistakes.
import { BRANCH_MAX_CHARS, PROJECT_MAX_CHARS, RECALL_DEFAULT_LIMIT } from '../config.ts'
import { type Memory, SatchelError, type Store } from '../types.ts'
import { checkpointCommit, renderBrief, renderMemories, renderMemory } from './render.ts'
import type { BriefArgs, CheckpointArgs, ForgetArgs, MemorizeArgs, RecallArgs } from './schemas.ts'
import { flattenLine } from './text.ts'

export interface SatchelService {
  brief(args: BriefArgs): Promise<string>
  recall(args: RecallArgs, client: string): Promise<string>
  memorize(args: MemorizeArgs, client: string): Promise<string>
  forget(args: ForgetArgs, client: string): Promise<string>
  checkpoint(args: CheckpointArgs, client: string): Promise<string>
}

const SCOPE_REQUIREMENTS = {
  global: () => undefined,
  project: (args: MemorizeArgs) =>
    args.project ? undefined : 'scope "project" needs `project` (host/owner/repo).',
  host: (args: MemorizeArgs) => (args.host ? undefined : 'scope "host" needs `host`.'),
} satisfies Record<NonNullable<MemorizeArgs['scope']>, (args: MemorizeArgs) => string | undefined>

function assertScopeFields(args: MemorizeArgs): void {
  const problem = SCOPE_REQUIREMENTS[args.scope ?? 'global'](args)
  if (problem) throw new SatchelError('invalid', problem)
}

function similarSection(newId: string, similar: Memory[]): string[] {
  if (similar.length === 0) return []
  return [
    'Similar existing memories. If one states the same fact, merge: call `memorize` with',
    `replaces=<its id> and the combined text, then \`forget\` ${newId}.`,
    renderMemories(similar),
  ]
}

function branchLabel(project: string, branch: string): string {
  return `${flattenLine(project, PROJECT_MAX_CHARS)} @ ${flattenLine(branch, BRANCH_MAX_CHARS)}`
}

export function createSatchelService(options: { store: Store }): SatchelService {
  const { store } = options

  async function brief(args: BriefArgs): Promise<string> {
    const [core, topics, hosts] = await Promise.all([store.core(), store.topics(), store.hosts()])
    const general = { core, topics, hosts, host: args.host }
    if (args.project === undefined) {
      return renderBrief({ ...general, checkpoints: [], projectMemoryCount: 0 })
    }
    const [checkpoints, projectMemoryCount] = await Promise.all([
      store.checkpoints(args.project, args.branch),
      store.projectMemoryCount(args.project),
    ])
    return renderBrief({
      ...general,
      project: args.project,
      branch: args.branch,
      checkpoints,
      projectMemoryCount,
    })
  }

  async function recall(args: RecallArgs, client: string): Promise<string> {
    if (args.query === undefined && args.topic === undefined && args.host === undefined) {
      throw new SatchelError('invalid', 'Give `query`, `topic` or `host` (or a combination).')
    }
    const memories = await store.recall({
      query: args.query,
      topic: args.topic,
      project: args.project,
      host: args.host,
      limit: args.limit ?? RECALL_DEFAULT_LIMIT,
      client,
    })
    if (memories.length === 0) return 'No matching memories.'
    return renderMemories(memories)
  }

  async function memorize(args: MemorizeArgs, client: string): Promise<string> {
    assertScopeFields(args)
    const { memory, similar } = await store.memorize({
      text: args.text,
      topic: args.topic,
      scope: args.scope ?? 'global',
      project: args.project,
      host: args.host,
      filetypes: args.filetypes,
      tags: args.tags,
      topicTrigger: args.topic_trigger,
      replaces: args.replaces,
      source: client,
    })
    const verb = args.replaces ? 'Updated' : 'Saved'
    return [`${verb}:`, renderMemory(memory), ...similarSection(memory.id, similar)].join('\n')
  }

  async function forget(args: ForgetArgs, client: string): Promise<string> {
    await store.forget(args.id, client)
    return `Deleted ${flattenLine(args.id, 16)}.`
  }

  async function checkpoint(args: CheckpointArgs, client: string): Promise<string> {
    if (args.done) {
      await store.dropCheckpoint(args.project, args.branch, client)
      return `Checkpoint for ${branchLabel(args.project, args.branch)} removed.`
    }
    const saved = await store.checkpoint({
      project: args.project,
      branch: args.branch,
      commit: args.commit,
      summary: args.summary,
      source: client,
    })
    return `Checkpoint ${saved.id} saved for ${branchLabel(saved.project, saved.branch)} at ${checkpointCommit(saved)}.`
  }

  return { brief, recall, memorize, forget, checkpoint }
}
