// Streamable HTTP at /mcp, stateless: one McpServer and transport per POST. Building a server
// is a handful of object allocations; only `initialize` reads the store (for instructions).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type InitializeRequest, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Request, RequestHandler, Response } from 'express'
import type { log } from '../log.ts'
import type { Store } from '../types.ts'
import {
  clientFromSessionId,
  sanitizeClientName,
  sessionIdFor,
  UNKNOWN_CLIENT,
} from './client-identity.ts'
import { RULES, renderInstructions } from './instructions.ts'
import type { SatchelService } from './service.ts'
import { registerSatchelTools } from './tools.ts'

type Log = typeof log

export const SERVER_NAME = 'satchel'
const JSONRPC_INTERNAL_ERROR = -32603
const JSONRPC_SERVER_ERROR = -32000

export interface McpHandlerOptions {
  store: Store
  service: SatchelService
  log: Log
  version: string
}

interface ConnectionContext {
  client: string
  instructions?: string
  sessionId?: () => string
}

async function instructionsFromStore(store: Store, logger: Log): Promise<string> {
  try {
    const [topics, labels] = await Promise.all([store.topics(), store.labels()])
    return renderInstructions(topics, { labels })
  } catch (error) {
    logger.error('could not list topics for instructions', { error: String(error) })
    return RULES
  }
}

async function initializeContext(
  body: InitializeRequest,
  options: McpHandlerOptions,
): Promise<ConnectionContext> {
  const client = sanitizeClientName(body.params.clientInfo?.name, UNKNOWN_CLIENT)
  return {
    client,
    instructions: await instructionsFromStore(options.store, options.log),
    sessionId: () => sessionIdFor(client),
  }
}

function connectionContext(req: Request, options: McpHandlerOptions): Promise<ConnectionContext> {
  if (isInitializeRequest(req.body)) return initializeContext(req.body, options)
  return Promise.resolve({ client: clientFromSessionId(req.get('mcp-session-id')) })
}

function jsonRpcError(res: Response, options: { status: number; code: number; message: string }) {
  if (res.headersSent) return
  res.status(options.status).json({
    jsonrpc: '2.0',
    error: { code: options.code, message: options.message },
    id: null,
  })
}

export function createMcpHandler(options: McpHandlerOptions): {
  post: RequestHandler
  methodNotAllowed: RequestHandler
} {
  const { service, log: logger, version } = options

  const post: RequestHandler = async (req, res) => {
    try {
      const context = await connectionContext(req, options)
      const server = new McpServer(
        { name: SERVER_NAME, version },
        { instructions: context.instructions },
      )
      registerSatchelTools(server, { service, client: context.client, log: logger })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: context.sessionId,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error('mcp request failed', { error: String(error) })
      jsonRpcError(res, { status: 500, code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' })
    }
  }

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.set('Allow', 'POST')
    jsonRpcError(res, { status: 405, code: JSONRPC_SERVER_ERROR, message: 'Method not allowed' })
  }

  return { post, methodNotAllowed }
}
