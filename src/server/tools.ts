// MCP tool registration. Descriptions are the main prompt a model sees: they say when to call.
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server'
import type { log } from '../log.ts'
import { SatchelError } from '../types.ts'
import { clientFromEnvelope } from './client-identity.ts'
import {
  briefSchema,
  checkpointSchema,
  forgetSchema,
  memorizeSchema,
  readSchema,
  recallSchema,
  saveReferenceSchema,
} from './schemas.ts'
import type { SatchelService } from './service.ts'

type Log = typeof log
type ToolName =
  | 'brief'
  | 'recall'
  | 'memorize'
  | 'save_reference'
  | 'read'
  | 'forget'
  | 'checkpoint'

export const TOOL_DESCRIPTIONS = {
  brief:
    'Load your long-term memory. Call this once at the start of every conversation, before other work, even if you already saw Satchel instructions. Returns standing facts and preferences (core), the topic map with the tags, file types and `about` entities in use, the machines that have machine-specific memories, and where work stopped: the checkpoint for `context` and `thread`, or the most recent checkpoints when they are not given. In a git repo pass `context` (origin as host/owner/repo, else the directory name), the current branch as `thread`, and `host` (this machine\'s short hostname); outside one, `context` is a short name for the undertaking. If you will write code, also pass `tags: ["code"]`, the `filetypes` involved and a tag for each library in use ("svelte"): the rules for that work are then loaded in full, and a rule labelled with a library loads only when its tag is given. Pass `about` (["person:alice"]) to load what is known about who or what the conversation concerns.',
  recall:
    'Fetch stored memories. Call before work that matches a topic trigger, when the user refers to an earlier session, before guessing at a convention or preference, and before writing code that the brief did not load rules for. Give `query` to search, `topic` to list a topic, `about` to list what concerns a person, place or thing (e.g. ["person:alice"]), or `filetypes` and `tags` to load the rules for some work (e.g. filetypes ["py"], tags ["code"]); they combine, and `kind` (one of rule, fact, event, preference) narrows to that kind, or alone lists every memory of it. Pass `context` and `host` so local memories rank first. Expired memories are left out. Results are whole memories in pages: when a page ends with "Next page", call again with that `offset` until you have them all.',
  memorize:
    'Save one durable memory. Call when the user asks you to remember something, corrects you, states a preference, or you learn something non-obvious that would have saved time. First paragraph: the rule or fact, 1-5 sentences; examples may follow. Not for what the repo records, secrets, or task progress (`checkpoint`). `kind`: rule, fact (default), event (with `date`) or preference; `origin`: stated when the user said it, inferred (default) when you concluded it. `about`: who or what it concerns (["person:alice"]); `expires`: when it stops applying. scope: global by default, including preferences; context only for facts about that repository or undertaking; host only for facts about that machine. Set `filetypes` or `tags` only when a rule is limited to that work: it then loads automatically. Use an existing topic; a new one needs `topic_trigger`. To update a memory, give `replaces` plus only the fields that change; the rest are kept ([] clears a list, null clears date or expires).',
  // biome-ignore lint/style/useNamingConvention: tool name fixed by docs/design.md
  save_reference:
    'Save verbatim material to consult or copy later: a config file (biome.json), a template, a checklist, a script. Give a short `title` and a one-line `description` of what it is for: they are what search matches and what listings show. `content` is stored exactly as given; `format` is its language. Use `memorize` for rules and facts; references are never loaded automatically, only listed by `recall` and `brief`, and fetched with `read`. topic, scope, filetypes, tags, about and expires work as for `memorize`; `replaces` updates one in place, keeping the fields left out.',
  read: 'Return the full content of a reference (r_...) that `recall` or `brief` listed, or of a memory (m_...), expired or not.',
  forget:
    'Delete a memory (m_...), reference (r_...) or checkpoint (c_...) by id; the reply says what went. Call when the user asks you to forget something, or a memory is wrong or obsolete and not worth rewriting with `memorize` + `replaces`.',
  checkpoint:
    'Record where work stopped on one thread of one context so a later session can resume. `context` and `thread` are what `brief` took: in a git repo the project id (host/owner/repo, else the directory name) and the branch; outside one, a short name for the undertaking ("grant-proposal") and "main" by default. Call when stopping work (end of session, hand-off, switching threads) with a 1-3 sentence summary: what is done, what is next, what blocks, and the HEAD `commit` for code. Overwrites the previous checkpoint for that thread; omitting `summary` or `commit` keeps the stored one. `done: true` deletes it once the thread is merged, finished or abandoned.',
} satisfies Record<ToolName, string>

const INTERNAL_ERROR_TEXT = 'Satchel hit an internal error; the operation did not complete.'

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export async function runTool(
  options: { tool: string; log: Log },
  operation: () => Promise<string>,
): Promise<CallToolResult> {
  try {
    return textResult(await operation())
  } catch (error) {
    if (error instanceof SatchelError) return errorResult(error.message)
    options.log.error('tool failed', { tool: options.tool, error: String(error) })
    return errorResult(INTERNAL_ERROR_TEXT)
  }
}

export function registerSatchelTools(
  server: McpServer,
  options: {
    service: SatchelService
    /** Who is writing when the request's `_meta` envelope does not say (2025 clients). */
    fallbackClient: string
    log: Log
  },
): void {
  const { service, fallbackClient, log } = options
  const run = (tool: string, operation: () => Promise<string>) => runTool({ tool, log }, operation)
  const clientOf = (context: ServerContext) =>
    clientFromEnvelope(context.mcpReq.envelope) ?? fallbackClient

  server.registerTool(
    'brief',
    {
      title: 'Load memory brief',
      description: TOOL_DESCRIPTIONS.brief,
      inputSchema: briefSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, context) => run('brief', () => service.brief(args, clientOf(context))),
  )
  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description: TOOL_DESCRIPTIONS.recall,
      inputSchema: recallSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, context) => run('recall', () => service.recall(args, clientOf(context))),
  )
  server.registerTool(
    'memorize',
    {
      title: 'Memorize a fact',
      description: TOOL_DESCRIPTIONS.memorize,
      inputSchema: memorizeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args, context) => run('memorize', () => service.memorize(args, clientOf(context))),
  )
  server.registerTool(
    'save_reference',
    {
      title: 'Save a reference',
      description: TOOL_DESCRIPTIONS.save_reference,
      inputSchema: saveReferenceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args, context) => run('save_reference', () => service.saveReference(args, clientOf(context))),
  )
  server.registerTool(
    'read',
    {
      title: 'Read a reference',
      description: TOOL_DESCRIPTIONS.read,
      inputSchema: readSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, context) => run('read', () => service.read(args, clientOf(context))),
  )
  server.registerTool(
    'forget',
    {
      title: 'Forget a memory',
      description: TOOL_DESCRIPTIONS.forget,
      inputSchema: forgetSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args, context) => run('forget', () => service.forget(args, clientOf(context))),
  )
  server.registerTool(
    'checkpoint',
    {
      title: 'Save work checkpoint',
      description: TOOL_DESCRIPTIONS.checkpoint,
      inputSchema: checkpointSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args, context) => run('checkpoint', () => service.checkpoint(args, clientOf(context))),
  )
}
