// MCP tool registration. Descriptions are the main prompt a model sees: they say when to call.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { log } from '../log.ts'
import { SatchelError } from '../types.ts'
import {
  briefShape,
  checkpointShape,
  forgetShape,
  memorizeShape,
  readShape,
  recallShape,
  saveReferenceShape,
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
    'Load your long-term memory. Call this once at the start of every conversation, before other work, even if you already saw Satchel instructions. Returns standing facts and preferences (core), the topic map with the tags, file types and `about` entities in use, the machines that have machine-specific memories, and where work stopped: the checkpoint for `project` and `branch` in a git repo, for `context` and `thread` in work outside one, or the most recent checkpoints when neither is given. In a git repo pass `project` (origin as host/owner/repo, else the directory name), the current `branch`, and `host` (this machine\'s short hostname). If you will write code, also pass `tags: ["code"]`, the `filetypes` involved and tags for libraries in use: the rules for that work are then loaded in full.',
  recall:
    'Fetch stored memories. Call before work that matches a topic trigger, when the user refers to an earlier session, before guessing at a convention or preference, and before writing code that the brief did not load rules for. Give `query` to search, `topic` to list a topic, `about` to list what concerns a person, place or thing (e.g. ["person:alice"]), or `filetypes` and `tags` to load the rules for some work (e.g. filetypes ["py"], tags ["code"]); they combine, and `kind` (one of rule, fact, event, preference) narrows to that kind. Pass `project` and `host` so local memories rank first. Expired memories are left out. Results are whole memories in pages: when a page ends with "Next page", call again with that `offset` until you have them all.',
  memorize:
    'Save one durable memory. Call when the user asks you to remember something, corrects you, states a preference, or you learn something non-obvious that would have saved time. First paragraph: the rule or fact, 1-5 sentences; examples may follow. Not for what the repo already records, secrets, or task progress (`checkpoint`). `kind`: rule, fact (default), event (with `date`) or preference; `origin`: stated when the user said it, inferred (default) when you concluded it. `about`: who or what it concerns (["person:alice"]); `expires`: when it stops applying. scope: global by default, including any preference; project only for facts about that repository; host only for facts about that machine itself. Set `filetypes` or `tags` only when a rule is limited to that work: it then loads automatically. Use an existing topic; a new one needs `topic_trigger`. To update a memory, give `replaces` plus only the fields that change; the rest are kept ([] clears a list, null clears date or expires).',
  // biome-ignore lint/style/useNamingConvention: tool name fixed by docs/design.md
  save_reference:
    'Save verbatim material to consult or copy later: a config file (biome.json), a template, a checklist, a script. Give a short `title` and a one-line `description` of what it is for: they are what search matches and what listings show. `content` is stored exactly as given; `format` is its language. Use `memorize` for rules and facts; references are never loaded automatically, only listed by `recall` and `brief`, and fetched with `read`. topic, scope, filetypes, tags, about and expires work as for `memorize`; `replaces` updates one in place, keeping the fields left out.',
  read: 'Return the full content of a reference (r_...) that `recall` or `brief` listed, or of a memory (m_...), expired or not.',
  forget:
    'Delete a memory (m_...), reference (r_...) or checkpoint (c_...) by id. Call when the user asks you to forget something, or a memory is wrong or obsolete and not worth rewriting with `memorize` + `replaces`.',
  checkpoint:
    'Record where work stopped on one thread of one context so a later session can resume. In a git repo, `context` is the same id `brief` takes as `project` (host/owner/repo, else the directory name) and `thread` is the branch; outside one, `context` is a short name for the undertaking ("grant-proposal") and `thread` is "main" by default. Call when stopping work (end of session, hand-off, switching threads) with a 1-3 sentence summary: what is done, what is next, what blocks, and the HEAD `commit` for code. Overwrites the previous checkpoint for that thread; omitting `summary` or `commit` keeps the stored one. `done: true` deletes it once the thread is merged, finished or abandoned.',
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
  options: { service: SatchelService; client: string; log: Log },
): void {
  const { service, client, log } = options
  const run = (tool: string, operation: () => Promise<string>) => runTool({ tool, log }, operation)

  server.registerTool(
    'brief',
    {
      title: 'Load memory brief',
      description: TOOL_DESCRIPTIONS.brief,
      inputSchema: briefShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('brief', () => service.brief(args, client)),
  )
  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description: TOOL_DESCRIPTIONS.recall,
      inputSchema: recallShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('recall', () => service.recall(args, client)),
  )
  server.registerTool(
    'memorize',
    {
      title: 'Memorize a fact',
      description: TOOL_DESCRIPTIONS.memorize,
      inputSchema: memorizeShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => run('memorize', () => service.memorize(args, client)),
  )
  server.registerTool(
    'save_reference',
    {
      title: 'Save a reference',
      description: TOOL_DESCRIPTIONS.save_reference,
      inputSchema: saveReferenceShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => run('save_reference', () => service.saveReference(args, client)),
  )
  server.registerTool(
    'read',
    {
      title: 'Read a reference',
      description: TOOL_DESCRIPTIONS.read,
      inputSchema: readShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run('read', () => service.read(args, client)),
  )
  server.registerTool(
    'forget',
    {
      title: 'Forget a memory',
      description: TOOL_DESCRIPTIONS.forget,
      inputSchema: forgetShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => run('forget', () => service.forget(args, client)),
  )
  server.registerTool(
    'checkpoint',
    {
      title: 'Save work checkpoint',
      description: TOOL_DESCRIPTIONS.checkpoint,
      inputSchema: checkpointShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => run('checkpoint', () => service.checkpoint(args, client)),
  )
}
