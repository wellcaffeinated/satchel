// MCP tool registration. Descriptions are the main prompt a model sees: they say when to call.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { log } from '../log.ts'
import { SatchelError } from '../types.ts'
import { briefShape, checkpointShape, forgetShape, memorizeShape, recallShape } from './schemas.ts'
import type { SatchelService } from './service.ts'

type Log = typeof log
type ToolName = 'brief' | 'recall' | 'memorize' | 'forget' | 'checkpoint'

export const TOOL_DESCRIPTIONS = {
  brief:
    'Load your long-term memory. Call this once at the start of every conversation, before other work, even if you already saw Satchel instructions. Returns standing facts and preferences (core), the topic map with the tags and file types in use, the machines that have machine-specific memories, and with `project`: where work stopped. In a git repo pass `project` (origin as host/owner/repo, else the directory name), the current `branch`, and `host` (this machine\'s short hostname). If you will write code, also pass `tags: ["code"]`, the `filetypes` involved and tags for libraries in use: the rules for that work are then loaded in full.',
  recall:
    'Fetch stored memories. Call before work that matches a topic trigger, when the user refers to an earlier session, before guessing at a convention or preference, and before writing code that the brief did not load rules for. Give `query` to search, `topic` to list a topic, or `filetypes` and `tags` to load the rules for some work (e.g. filetypes ["py"], tags ["code"]); they combine. Pass `project` and `host` so local memories rank first. Results are whole memories in pages: when a page ends with "Next page", call again with that `offset` until you have them all.',
  memorize:
    'Save one durable rule or fact. Call when the user asks you to remember something, corrects you, states a preference, or you learn something non-obvious that would have saved time. First paragraph: the rule, 1-5 self-contained sentences; examples (e.g. a BAD/GOOD code block) may follow. Not for what the repo already records, secrets, or task progress (use `checkpoint`). scope: global by default, including any preference, even one stated on a particular machine; project only for facts about that repository; host only for facts about that machine itself. Set `filetypes` (["ts"]) or `tags` (["code"] for any code, a library like ["rxjs"]) only when the rule is limited to that work: it then loads automatically for it. Use an existing topic; a new one needs `topic_trigger` ("read before ..."). If similar memories come back, merge with `replaces`.',
  forget:
    'Delete a memory (m_...) or checkpoint (c_...) by id. Call when the user asks you to forget something, or a memory is wrong or obsolete and not worth rewriting with `memorize` + `replaces`.',
  checkpoint:
    'Record where work stopped on one branch of one project so a later session can resume. Call when stopping work on a branch (end of session, hand-off, switching branches) with the HEAD commit and a 1-3 sentence summary: what is done, what is next, what blocks. Overwrites the previous checkpoint for that branch; omitting `summary` keeps the stored one. `done: true` deletes it once the branch is merged or abandoned.',
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
