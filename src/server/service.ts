// The operations behind the MCP tools. Each returns the text a model reads
// and throws SatchelError for caller mistakes.
import {
  BRANCH_MAX_CHARS,
  BRIEF_LOADED_MAX_CHARS,
  FILETYPE_PATTERN,
  PROJECT_MAX_CHARS,
  RECALL_DEFAULT_LIMIT,
  RECALL_PAGE_MAX_CHARS,
  TAG_PATTERN,
} from '../config.ts'
import { type Memory, SatchelError, type Store } from '../types.ts'
import { pageOf } from './paging.ts'
import {
  checkpointCommit,
  type LoadedForWork,
  recallFooter,
  renderBrief,
  renderMemories,
  renderMemory,
  type WorkLabels,
} from './render.ts'
import type { BriefArgs, CheckpointArgs, ForgetArgs, MemorizeArgs, RecallArgs } from './schemas.ts'
import { flattenLine } from './text.ts'

export interface SatchelService {
  brief(args: BriefArgs, client: string): Promise<string>
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

// Requests are lenient: a client describing its work (every dependency, say) should not fail
// on one odd name, so values are normalised and the ones that cannot be labels are dropped.
const REQUEST_LABEL_RULES = {
  filetypes: {
    normalise: (value: string) => value.trim().toLowerCase().replace(/^\./, ''),
    pattern: FILETYPE_PATTERN,
  },
  tags: { normalise: (value: string) => value.trim().toLowerCase(), pattern: TAG_PATTERN },
}

function requestLabels(
  kind: keyof typeof REQUEST_LABEL_RULES,
  values: string[] | undefined,
): string[] | undefined {
  const rule = REQUEST_LABEL_RULES[kind]
  const labels = [...new Set((values ?? []).map(rule.normalise))].filter((value) =>
    rule.pattern.test(value),
  )
  return labels.length === 0 ? undefined : labels
}

function workLabels(args: { filetypes?: string[]; tags?: string[] }): WorkLabels | undefined {
  const filetypes = requestLabels('filetypes', args.filetypes)
  const tags = requestLabels('tags', args.tags)
  if (filetypes === undefined && tags === undefined) return undefined
  return { ...(filetypes ? { filetypes } : {}), ...(tags ? { tags } : {}) }
}

/** Size of a memory as recall prints it, newline included. */
function renderedSize(memory: Memory): number {
  return renderMemory(memory).length + 1
}

function branchLabel(project: string, branch: string): string {
  return `${flattenLine(project, PROJECT_MAX_CHARS)} @ ${flattenLine(branch, BRANCH_MAX_CHARS)}`
}

export function createSatchelService(options: { store: Store }): SatchelService {
  const { store } = options

  async function loadedForWork(
    args: BriefArgs,
    client: string,
  ): Promise<LoadedForWork | undefined> {
    const work = workLabels(args)
    if (work === undefined) return undefined
    const memories = await store.recall({ ...work, project: args.project, host: args.host })
    const page = pageOf({
      items: memories,
      offset: 0,
      maxChars: BRIEF_LOADED_MAX_CHARS,
      size: renderedSize,
    })
    await store.logRecall({ ids: page.items.map((memory) => memory.id), client })
    return { work, page }
  }

  async function brief(args: BriefArgs, client: string): Promise<string> {
    const [core, topics, hosts, labels, loaded] = await Promise.all([
      store.core(),
      store.topics(),
      store.hosts(),
      store.labels(),
      loadedForWork(args, client),
    ])
    const general = { core, topics, hosts, host: args.host, labels, loaded }
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
    const work = workLabels(args)
    const asked = [args.query, args.topic, args.host, work].some((value) => value !== undefined)
    if (!asked) {
      throw new SatchelError(
        'invalid',
        'Give `query`, `topic`, `host`, `filetypes` or `tags` (or a combination).',
      )
    }
    const memories = await store.recall({
      query: args.query,
      topic: args.topic,
      project: args.project,
      host: args.host,
      ...work,
    })
    if (memories.length === 0) return 'No matching memories.'
    const page = pageOf({
      items: memories,
      offset: args.offset ?? 0,
      limit: args.limit ?? (args.query === undefined ? undefined : RECALL_DEFAULT_LIMIT),
      maxChars: RECALL_PAGE_MAX_CHARS,
      size: renderedSize,
    })
    await store.logRecall({ ids: page.items.map((memory) => memory.id), client })
    const shown = page.items.length === 0 ? [] : [renderMemories(page.items)]
    return [...shown, ...recallFooter(page)].join('\n')
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
