// pnpm mcp: a thin MCP client that shows what a model sees from a Satchel server: the
// instructions, the tool descriptions, and one tool call's result, each with its length.
// Connects to the running `pnpm sandbox` unless --url is given. See docs/design.md.

import { parseArgs } from 'node:util'
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client'
import { log } from '../src/log.ts'
import { readSandboxState, type SandboxState } from './sandbox.ts'

const DEFAULT_CLIENT_NAME = 'satchel-cli'
const CLIENT_VERSION = '0.0.0'

const EXIT_OK = 0
const EXIT_TOOL_ERROR = 1
const EXIT_USAGE = 2

export const USAGE = `Usage:
  pnpm mcp --list                    tool names, descriptions and arguments, with character counts
  pnpm mcp <tool> ['<json args>']    the instructions, then one tool call's result

Options:
  --url <base>      server base URL (default: the running pnpm sandbox)
  --token <token>   bearer token (default with no --url: the sandbox's token)
  --client <name>   clientInfo name the server records as the writer (default: ${DEFAULT_CLIENT_NAME})
`

type Write = (text: string) => void
type ReadState = () => Promise<SandboxState | undefined>
type ServerAction = (client: Client, write: Write) => Promise<number>

/** Either print the usage, or connect and run one action against the server. */
type Command = { kind: 'help' } | { kind: 'server'; action: ServerAction }

interface Cli {
  command: Command
  url?: string
  token?: string
  client: string
}

export interface McpRunOptions {
  argv: string[]
  readState: ReadState
  write: Write
}

/** A mistake in how the command was invoked: reported with the usage text, exit code 2. */
class UsageError extends Error {}

function section(title: string, text: string): string {
  return `--- ${title} (${text.length} chars)\n${text}\n`
}

export function formatInstructions(instructions: string | undefined): string {
  return section('instructions', instructions ?? '')
}

/** "  name (required): description", one line per argument, as the model reads them. */
function formatParameters(schema: Tool['inputSchema']): string {
  const required = new Set(schema.required ?? [])
  const describe = ([name, property]: [string, unknown]) => {
    const description =
      typeof property === 'object' && property !== null && 'description' in property
        ? String(property.description)
        : ''
    const flag = required.has(name) ? ' (required)' : ''
    return `  ${name}${flag}: ${description}\n`
  }
  return Object.entries(schema.properties ?? {})
    .map(describe)
    .join('')
}

function formatTool(tool: Tool): string {
  return `${section(tool.name, tool.description ?? '')}${formatParameters(tool.inputSchema)}`
}

export function formatTools(tools: Tool[]): string {
  const total = tools.reduce((sum, tool) => sum + (tool.description ?? '').length, 0)
  return `${tools.map(formatTool).join('')}--- ${tools.length} tools, ${total} description chars\n`
}

/** The text a model would read from a tool result, and whether the server flagged an error. */
export function resultText(result: CallToolResult): { text: string; isError: boolean } {
  const describe = (part: CallToolResult['content'][number]) =>
    part.type === 'text' ? part.text : `[${part.type} content]`
  return { text: result.content.map(describe).join('\n'), isError: result.isError === true }
}

async function listTools(client: Client, write: Write): Promise<number> {
  const { tools } = await client.listTools()
  write(formatTools(tools))
  return EXIT_OK
}

function callTool(tool: string, args: Record<string, unknown>): ServerAction {
  return async (client, write) => {
    write(formatInstructions(client.getInstructions()))
    const { text, isError } = resultText(await client.callTool({ name: tool, arguments: args }))
    write(section(isError ? 'result, error' : 'result', text))
    return isError ? EXIT_TOOL_ERROR : EXIT_OK
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('tool arguments must be a JSON object')
  }
  return Object.fromEntries(Object.entries(parsed))
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {}
  try {
    return parseJsonObject(raw)
  } catch (error) {
    if (error instanceof SyntaxError) throw new UsageError(`tool arguments: ${error.message}`)
    throw error
  }
}

function commandOf(options: { list: boolean; help: boolean; positionals: string[] }): Command {
  const [tool, rawArgs, ...extra] = options.positionals
  if (options.help) return { kind: 'help' }
  if (options.list) return { kind: 'server', action: listTools }
  if (tool === undefined) return { kind: 'help' }
  if (extra.length > 0) throw new UsageError('pass the tool arguments as one JSON string')
  return { kind: 'server', action: callTool(tool, parseToolArgs(rawArgs)) }
}

function parseFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        url: { type: 'string' },
        token: { type: 'string' },
        client: { type: 'string', default: DEFAULT_CLIENT_NAME },
      },
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseFlags(argv)
  return {
    command: commandOf({ list: values.list ?? false, help: values.help ?? false, positionals }),
    url: values.url,
    token: values.token,
    client: values.client ?? DEFAULT_CLIENT_NAME,
  }
}

async function connectionFor(
  cli: Cli,
  readState: ReadState,
): Promise<{ url: string; token?: string }> {
  if (cli.url !== undefined) return { url: cli.url, token: cli.token }
  const state = await readState()
  if (state === undefined) {
    throw new UsageError('no sandbox is running: start `pnpm sandbox`, or pass --url')
  }
  return { url: state.url, token: cli.token ?? state.token }
}

async function connect(options: { url: string; token?: string; clientName: string }) {
  const headers = options.token
    ? Object.fromEntries([['Authorization', `Bearer ${options.token}`]])
    : undefined
  // Probe like Claude Code does: the 2026-07-28 era when the server offers it, else 2025.
  const client = new Client(
    { name: options.clientName, version: CLIENT_VERSION },
    { versionNegotiation: { mode: 'auto' } },
  )
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', options.url), {
    requestInit: { headers },
  })
  try {
    await client.connect(transport)
  } catch (error) {
    throw new Error(`could not connect to ${options.url}/mcp: ${String(error)}`)
  }
  return client
}

async function runOnServer(
  options: { cli: Cli; readState: ReadState; write: Write },
  action: ServerAction,
): Promise<number> {
  const connection = await connectionFor(options.cli, options.readState)
  const client = await connect({ ...connection, clientName: options.cli.client })
  try {
    return await action(client, options.write)
  } finally {
    await client.close()
  }
}

/** Runs one CLI invocation and returns the process exit code. */
export async function runMcp(options: McpRunOptions): Promise<number> {
  const { write } = options
  try {
    const cli = parseCli(options.argv)
    if (cli.command.kind === 'help') {
      write(USAGE)
      return EXIT_OK
    }
    return await runOnServer({ ...options, cli }, cli.command.action)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    write(`${error.message}\n\n${USAGE}`)
    return EXIT_USAGE
  }
}

if (import.meta.main) {
  runMcp({
    argv: process.argv.slice(2),
    readState: () => readSandboxState(),
    write: (text) => process.stdout.write(text),
  })
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      log.error('mcp failed', { error: error instanceof Error ? error.message : String(error) })
      process.exit(1)
    })
}
