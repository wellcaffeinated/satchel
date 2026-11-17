// The operations behind the MCP tools. Each returns the text a model reads
// and throws SatchelError for caller mistakes.
import {
  ABOUT_PATTERN,
  BRIEF_LOADED_MAX_CHARS,
  CONTEXT_MAX_CHARS,
  CORE_MAX_CHARS,
  DEFAULT_THREAD,
  DEFAULT_TIME_ZONE,
  FILETYPE_PATTERN,
  RECALL_DEFAULT_LIMIT,
  RECALL_PAGE_MAX_CHARS,
  RECENT_CHECKPOINTS_MAX,
  TAG_PATTERN,
  THREAD_MAX_CHARS,
} from '../config.ts'
import { type Forgotten, type Memory, SatchelError, type Store } from '../types.ts'
import { type Page, pageOf } from './paging.ts'
import {
  checkpointCommit,
  createRenderer,
  fitCore,
  type LoadedAbout,
  type LoadedForWork,
  recallFooter,
  renderReferenceLine,
  renderReferenceList,
  type WorkLabels,
} from './render.ts'
import { createReviewer } from './review.ts'
import type {
  BriefArgs,
  CheckpointArgs,
  ForgetArgs,
  MemorizeArgs,
  ReadArgs,
  RecallArgs,
  ReviewArgs,
  SaveReferenceArgs,
} from './schemas.ts'
import { flattenLine } from './text.ts'

const FORGOTTEN_SHOWN_CHARS = 100

export interface SatchelService {
  brief(args: BriefArgs, client: string): Promise<string>
  recall(args: RecallArgs, client: string): Promise<string>
  memorize(args: MemorizeArgs, client: string): Promise<string>
  saveReference(args: SaveReferenceArgs, client: string): Promise<string>
  read(args: ReadArgs, client: string): Promise<string>
  forget(args: ForgetArgs, client: string): Promise<string>
  checkpoint(args: CheckpointArgs, client: string): Promise<string>
  review(args: ReviewArgs): Promise<string>
}

type ScopedArgs = Pick<MemorizeArgs, 'scope' | 'context' | 'host'>

const SCOPE_REQUIREMENTS = {
  global: () => undefined,
  context: (args: ScopedArgs) =>
    args.context
      ? undefined
      : 'scope "context" needs `context` (the project id, or the undertaking).',
  host: (args: ScopedArgs) => (args.host ? undefined : 'scope "host" needs `host`.'),
} satisfies Record<NonNullable<ScopedArgs['scope']>, (args: ScopedArgs) => string | undefined>

/** For a new memory the scope fields must arrive together; a patch is checked once merged. */
function assertScopeFields(args: ScopedArgs & { replaces?: string }): void {
  if (args.replaces !== undefined) return
  const problem = SCOPE_REQUIREMENTS[args.scope ?? 'global'](args)
  if (problem) throw new SatchelError('invalid', problem)
}

function assertNewMemoryFields(args: MemorizeArgs): void {
  if (args.replaces !== undefined) return
  if (args.text === undefined || args.topic === undefined) {
    throw new SatchelError(
      'invalid',
      'A new memory needs `text` and `topic`; give `replaces` to update an existing one.',
    )
  }
}

function assertNewReferenceFields(args: SaveReferenceArgs): void {
  if (args.replaces !== undefined) return
  const missing = ['title', 'description', 'content', 'topic'].filter(
    (field) => args[field as keyof SaveReferenceArgs] === undefined,
  )
  if (missing.length > 0) {
    throw new SatchelError(
      'invalid',
      `A new reference needs ${missing.map((field) => `\`${field}\``).join(', ')}; give \`replaces\` to update an existing one.`,
    )
  }
}

function requireContext(args: CheckpointArgs): string {
  if (args.context !== undefined) return args.context
  throw new SatchelError(
    'invalid',
    'checkpoint needs `context`: in a repository the project id (host/owner/repo) with the branch as `thread`, as `brief` took them; outside one, a short name for the undertaking, e.g. "grant-proposal".',
  )
}

// Requests are lenient: a client describing its work (every dependency, say) should not fail
// on one odd name, so values are normalised and the ones that cannot be labels are dropped.
const REQUEST_LABEL_RULES = {
  filetypes: {
    normalise: (value: string) => value.trim().toLowerCase().replace(/^\./, ''),
    pattern: FILETYPE_PATTERN,
  },
  tags: { normalise: (value: string) => value.trim().toLowerCase(), pattern: TAG_PATTERN },
  about: { normalise: (value: string) => value.trim().toLowerCase(), pattern: ABOUT_PATTERN },
}

function requestLabels(
  kind: keyof typeof REQUEST_LABEL_RULES,
  values: string[] | undefined,
): string[] | undefined {
  if (values === undefined) return undefined
  const rule = REQUEST_LABEL_RULES[kind]
  return [...new Set(values.map(rule.normalise))].filter((value) => rule.pattern.test(value))
}

function workLabels(args: { filetypes?: string[]; tags?: string[] }): WorkLabels | undefined {
  const filetypes = requestLabels('filetypes', args.filetypes)
  const tags = requestLabels('tags', args.tags)
  if (!filetypes?.length && !tags?.length) return undefined
  return { ...(filetypes?.length ? { filetypes } : {}), ...(tags?.length ? { tags } : {}) }
}

function threadLabel(context: string, thread: string): string {
  return `${flattenLine(context, CONTEXT_MAX_CHARS)} @ ${flattenLine(thread, THREAD_MAX_CHARS)}`
}

/** What a deleted entry was, in a few words, so the model can confirm it was the right one. */
function describeForgotten(gone: Forgotten): string {
  const describers: Record<Forgotten['kind'], () => string> = {
    memory: () =>
      gone.kind === 'memory' ? flattenLine(gone.memory.text, FORGOTTEN_SHOWN_CHARS) : '',
    reference: () =>
      gone.kind === 'reference'
        ? `reference "${flattenLine(gone.reference.title, FORGOTTEN_SHOWN_CHARS)}"`
        : '',
    checkpoint: () =>
      gone.kind === 'checkpoint'
        ? `checkpoint for ${threadLabel(gone.checkpoint.context, gone.checkpoint.thread)}`
        : '',
  }
  return describers[gone.kind]()
}

export function createSatchelService(options: {
  store: Store
  timeZone?: string
  now?: () => Date
}): SatchelService {
  const { store, timeZone = DEFAULT_TIME_ZONE, now = () => new Date() } = options
  const render = createRenderer({ timeZone })
  const reviewer = createReviewer({ store, render, now })

  /** Size of a memory as recall prints it, newline included. */
  function renderedSize(memory: Memory): number {
    return render.renderMemory(memory).length + 1
  }

  async function loadedPage(
    request: Parameters<Store['recall']>[0],
    client: string,
  ): Promise<{ page: Page<Memory>; references: Awaited<ReturnType<Store['findReferences']>> }> {
    const [memories, references] = await Promise.all([
      store.recall(request),
      store.findReferences(request),
    ])
    const page = pageOf({
      items: memories,
      offset: 0,
      maxChars: BRIEF_LOADED_MAX_CHARS,
      size: renderedSize,
    })
    await store.logRecall({
      ids: page.items.map((memory) => memory.id),
      client,
      via: 'loaded',
      context: request.context,
    })
    return { page, references }
  }

  /** core.md and the pinned memories the caller can see, cut to the core's size. */
  async function coreFor(args: BriefArgs, client: string) {
    const [text, pinned] = await Promise.all([
      store.core(),
      store.pinned({ context: args.context, host: args.host }),
    ])
    const view = fitCore({ text, pinned, maxChars: CORE_MAX_CHARS })
    await store.logRecall({
      ids: view.shown.map((memory) => memory.id),
      client,
      via: 'core',
      context: args.context,
    })
    return view
  }

  async function loadedForWork(
    args: BriefArgs,
    client: string,
  ): Promise<LoadedForWork | undefined> {
    const work = workLabels(args)
    if (work === undefined) return undefined
    const request = { ...work, context: args.context, host: args.host }
    return { work, ...(await loadedPage(request, client)) }
  }

  async function loadedAbout(args: BriefArgs, client: string): Promise<LoadedAbout | undefined> {
    const about = requestLabels('about', args.about)
    if (!about?.length) return undefined
    const request = { about, context: args.context, host: args.host }
    return { about, ...(await loadedPage(request, client)) }
  }

  async function brief(args: BriefArgs, client: string): Promise<string> {
    const { context, thread } = args
    const [core, topics, hosts, labels, loaded, about, checkpoints, recent, contextMemoryCount] =
      await Promise.all([
        coreFor(args, client),
        store.topics(),
        store.hosts(),
        store.labels(),
        loadedForWork(args, client),
        loadedAbout(args, client),
        context === undefined ? [] : store.checkpoints(context, thread),
        context === undefined ? store.recentCheckpoints(RECENT_CHECKPOINTS_MAX) : [],
        context === undefined ? 0 : store.contextMemoryCount(context),
      ])
    return render.renderBrief({
      core,
      topics,
      hosts,
      host: args.host,
      labels,
      loaded,
      loadedAbout: about,
      context,
      thread,
      checkpoints,
      recent,
      contextMemoryCount,
    })
  }

  async function recall(args: RecallArgs, client: string): Promise<string> {
    const work = workLabels(args)
    const about = requestLabels('about', args.about)
    const asked = [args.query, args.topic, args.host, args.kind, work, about].some(
      (value) => value !== undefined,
    )
    if (!asked) {
      throw new SatchelError(
        'invalid',
        'Give `query`, `topic`, `host`, `kind`, `filetypes`, `tags` or `about` (or a combination).',
      )
    }
    const request = {
      query: args.query,
      topic: args.topic,
      context: args.context,
      host: args.host,
      kind: args.kind,
      ...work,
      ...(about === undefined ? {} : { about }),
    }
    const [memories, references] = await Promise.all([
      store.recall(request),
      store.findReferences(request),
    ])
    // References are short lines, listed once, on the first page.
    const referenceLines = (args.offset ?? 0) === 0 ? renderReferenceList(references) : []
    if (memories.length === 0) {
      return referenceLines.length > 0 ? referenceLines.join('\n') : 'No matching memories.'
    }
    const page = pageOf({
      items: memories,
      offset: args.offset ?? 0,
      limit: args.limit ?? (args.query === undefined ? undefined : RECALL_DEFAULT_LIMIT),
      maxChars: RECALL_PAGE_MAX_CHARS,
      size: renderedSize,
    })
    await store.logRecall({
      ids: page.items.map((memory) => memory.id),
      client,
      via: args.query === undefined ? 'recall' : 'search',
      context: args.context,
    })
    const shown = page.items.length === 0 ? [] : [render.renderMemories(page.items)]
    return [...shown, ...recallFooter(page), ...referenceLines].join('\n')
  }

  async function saveReference(args: SaveReferenceArgs, client: string): Promise<string> {
    assertNewReferenceFields(args)
    assertScopeFields(args)
    const reference = await store.saveReference({
      title: args.title,
      description: args.description,
      content: args.content,
      format: args.format,
      topic: args.topic,
      scope: args.scope,
      context: args.context,
      host: args.host,
      filetypes: args.filetypes,
      tags: args.tags,
      about: args.about,
      expires: args.expires,
      topicTrigger: args.topic_trigger,
      replaces: args.replaces,
      source: client,
    })
    const verb = args.replaces ? 'Updated' : 'Saved'
    return `${verb} reference (content ${reference.content.length} characters):\n${renderReferenceLine(reference)}`
  }

  async function read(args: ReadArgs, client: string): Promise<string> {
    const found = await store.read(args.id)
    if (found.kind === 'reference') return render.renderReference(found.reference)
    await store.logRecall({ ids: [found.memory.id], client, via: 'read' })
    return render.renderMemory(found.memory)
  }

  function similarSection(newId: string, similar: Memory[]): string[] {
    if (similar.length === 0) return []
    return [
      'Similar existing memories. If one states the same fact, merge: call `memorize` with',
      `replaces=<its id> and the combined text, then \`forget\` ${newId}.`,
      render.renderMemories(similar),
    ]
  }

  async function memorize(args: MemorizeArgs, client: string): Promise<string> {
    assertNewMemoryFields(args)
    assertScopeFields(args)
    const { memory, similar } = await store.memorize({
      text: args.text,
      topic: args.topic,
      kind: args.kind,
      origin: args.origin,
      date: args.date,
      expires: args.expires,
      about: args.about,
      scope: args.scope,
      context: args.context,
      host: args.host,
      filetypes: args.filetypes,
      tags: args.tags,
      core: args.core,
      topicTrigger: args.topic_trigger,
      replaces: args.replaces,
      source: client,
    })
    // The kind and origin are spelled out here even when they are the defaults, so a model
    // that left them out sees what it saved.
    const verb = args.replaces ? 'Updated' : 'Saved'
    // An update that leaves the text alone cannot have created a duplicate.
    const textUnchanged = args.replaces !== undefined && args.text === undefined
    return [
      `${verb} (${memory.kind}, ${memory.origin}):`,
      render.renderMemory(memory),
      ...(textUnchanged ? [] : similarSection(memory.id, similar)),
    ].join('\n')
  }

  async function forget(args: ForgetArgs, client: string): Promise<string> {
    const gone = await store.forget(args.id, client)
    return `Deleted ${flattenLine(args.id, 16)}: ${describeForgotten(gone)}`
  }

  async function checkpoint(args: CheckpointArgs, client: string): Promise<string> {
    const context = requireContext(args)
    const thread = args.thread ?? DEFAULT_THREAD
    if (args.done) {
      await store.dropCheckpoint(context, thread, client)
      return `Checkpoint for ${threadLabel(context, thread)} removed.`
    }
    const [previous] = await store.checkpoints(context, thread)
    const saved = await store.checkpoint({
      context,
      thread,
      commit: args.commit,
      summary: args.summary,
      source: client,
    })
    const at = saved.commit === undefined ? '' : ` at ${checkpointCommit(saved)}`
    const kept = args.summary === undefined && saved.summary !== '' ? ' (stored summary kept)' : ''
    // Said outright, because a default `thread` can silently replace someone else's summary.
    const verb = previous === undefined ? 'saved' : 'updated, replacing the previous one,'
    return `Checkpoint ${saved.id} ${verb} for ${threadLabel(saved.context, saved.thread)}${at}${kept}.`
  }

  return {
    brief,
    recall,
    memorize,
    saveReference,
    read,
    forget,
    checkpoint,
    review: reviewer.review,
  }
}
