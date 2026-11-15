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
    'Load your long-term memory. Call this once at the start of every conversation, before other work, even if you already saw Satchel instructions. Returns standing facts and preferences (core), the topic map (each topic with a "read before ..." trigger), and with `project`: where work stopped and how many project memories exist. In a git repo pass `project` (origin as host/owner/repo, else the directory name) and the current `branch`.',
  recall:
    'Fetch stored memories. Call before work that matches a topic trigger from the brief, when the user refers to an earlier session, or before guessing at a convention, preference or setup detail. Give `topic` to list a topic, `query` (words or a question) to search, or both. In a repo pass `project` so its memories rank first. Each result has id, topic, scope and date.',
  memorize:
    'Save one durable fact for future sessions. Call when the user asks you to remember something, corrects you, states a preference, or you learn something non-obvious that would have saved time (a gotcha, setup detail, decision and its reason). One fact per call, 1-5 self-contained sentences. Do not save what the repo or its docs already record, secrets, or task progress (use `checkpoint`). scope: global (default), project (set `project`), host (set `host`). Use an existing topic; a new topic needs `topic_trigger`, one line: "read before ...". If similar memories come back, merge with `replaces`.',
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
    (args) => run('brief', () => service.brief(args)),
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
