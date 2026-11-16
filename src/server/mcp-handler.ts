// Streamable HTTP at /mcp, stateless: one McpServer per POST, from one factory for both protocol
// eras. 2026-07-28 requests go to the SDK's `createMcpHandler`. 2025 requests are served here
// instead of by its built-in legacy fallback, because that fallback never issues an
// Mcp-Session-Id, and 2025 clients need one to carry their name (see client-identity.ts).
// Building a server is a handful of object allocations; only `initialize` and
// `server/discover` read the store (for instructions).
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node'
import {
  createMcpHandler as createSdkMcpHandler,
  type InitializeRequest,
  isInitializeRequest,
  isLegacyRequest,
  type McpRequestContext,
  McpServer,
} from '@modelcontextprotocol/server'
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
const DISCOVER_METHOD = 'server/discover'

export interface McpHandlerOptions {
  store: Store
  service: SatchelService
  log: Log
  version: string
}

interface ServerSetup {
  /** Who is writing when the request itself does not say (2025 clients). */
  fallbackClient: string
  instructions?: string
}

interface LegacyConnection extends ServerSetup {
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

async function initializeConnection(
  body: InitializeRequest,
  options: McpHandlerOptions,
): Promise<LegacyConnection> {
  const client = sanitizeClientName(body.params.clientInfo?.name, UNKNOWN_CLIENT)
  return {
    fallbackClient: client,
    instructions: await instructionsFromStore(options.store, options.log),
    sessionId: () => sessionIdFor(client),
  }
}

function legacyConnection(req: Request, options: McpHandlerOptions): Promise<LegacyConnection> {
  if (isInitializeRequest(req.body)) return initializeConnection(req.body, options)
  return Promise.resolve({ fallbackClient: clientFromSessionId(req.get('mcp-session-id')) })
}

async function requestMethod(request: globalThis.Request | undefined): Promise<unknown> {
  if (!request) return undefined
  const body: unknown = await request.clone().json()
  if (typeof body !== 'object' || body === null || !('method' in body)) return undefined
  return body.method
}

async function modernSetup(
  context: McpRequestContext,
  options: McpHandlerOptions,
): Promise<ServerSetup> {
  const method = await requestMethod(context.requestInfo)
  if (method !== DISCOVER_METHOD) return { fallbackClient: UNKNOWN_CLIENT }
  return {
    fallbackClient: UNKNOWN_CLIENT,
    instructions: await instructionsFromStore(options.store, options.log),
  }
}

function buildServer(setup: ServerSetup, options: McpHandlerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    { instructions: setup.instructions },
  )
  registerSatchelTools(server, {
    service: options.service,
    fallbackClient: setup.fallbackClient,
    log: options.log,
  })
  return server
}

function jsonRpcError(res: Response, options: { status: number; code: number; message: string }) {
  if (res.headersSent) return
  res.status(options.status).json({
    jsonrpc: '2.0',
    error: { code: options.code, message: options.message },
    id: null,
  })
}

function createLegacyHandler(options: McpHandlerOptions) {
  return async (req: Request, res: Response) => {
    const connection = await legacyConnection(req, options)
    const server = buildServer(connection, options)
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: connection.sessionId,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }
}

function createModernHandler(options: McpHandlerOptions) {
  const handler = createSdkMcpHandler(
    async (context) => buildServer(await modernSetup(context, options), options),
    {
      legacy: 'reject',
      responseMode: 'json',
      onerror: (error) => options.log.error('mcp request failed', { error: String(error) }),
    },
  )
  return toNodeHandler(handler)
}

export function createMcpHandler(options: McpHandlerOptions): {
  post: RequestHandler
  methodNotAllowed: RequestHandler
} {
  const serveLegacy = createLegacyHandler(options)
  const serveModern = createModernHandler(options)

  const post: RequestHandler = async (req, res) => {
    try {
      const legacy = await isLegacyRequest(await toWebRequest(req, req.body), req.body)
      if (legacy) return await serveLegacy(req, res)
      await serveModern(req, res, req.body)
    } catch (error) {
      options.log.error('mcp request failed', { error: String(error) })
      jsonRpcError(res, { status: 500, code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' })
    }
  }

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.set('Allow', 'POST')
    jsonRpcError(res, { status: 405, code: JSONRPC_SERVER_ERROR, message: 'Method not allowed' })
  }

  return { post, methodNotAllowed }
}
