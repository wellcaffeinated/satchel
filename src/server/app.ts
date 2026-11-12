// The Express app: /healthz (unauthenticated), then auth, then /mcp and the REST endpoints.
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
} from 'express'
import type * as z from 'zod'
import { JSON_BODY_LIMIT_BYTES } from '../config.ts'
import type { log } from '../log.ts'
import { SatchelError, type Store } from '../types.ts'
import { REST_CLIENT, sanitizeClientName } from './client-identity.ts'
import { createMcpHandler } from './mcp-handler.ts'
import { briefSchema, briefShape, checkpointSchema } from './schemas.ts'
import { createSatchelService, type SatchelService } from './service.ts'

type Log = typeof log

const CLIENT_HEADER = 'x-satchel-client'
const BRIEF_QUERY_KEYS = Object.keys(briefShape)
const CLIENT_ERROR_MIN = 400
const CLIENT_ERROR_MAX = 499

export interface AppOptions {
  store: Store
  authenticate: RequestHandler
  log: Log
  version: string
  /** DNS-rebinding protection (Host must be a loopback name). For unauthenticated loopback use. */
  loopbackHostsOnly?: boolean
}

function restClient(req: Request): string {
  return sanitizeClientName(req.get(CLIENT_HEADER), REST_CLIENT)
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  return undefined
}

function describeIssues(error: z.ZodError): string {
  const describe = (issue: z.core.$ZodIssue) =>
    `${issue.path.join('.') || 'body'}: ${issue.message}`
  return error.issues.map(describe).join('; ')
}

function sendText(res: express.Response, status: number, text: string) {
  res.status(status).type('text/plain; charset=utf-8').send(text)
}

function restHandler(
  logger: Log,
  handle: (req: Request, res: express.Response) => Promise<void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await handle(req, res)
    } catch (error) {
      if (error instanceof SatchelError) return sendText(res, 400, error.message)
      logger.error('rest request failed', { path: req.path, error: String(error) })
      sendText(res, 500, 'internal error')
    }
  }
}

function briefEndpoint(service: SatchelService, logger: Log): RequestHandler {
  return restHandler(logger, async (req, res) => {
    const query = Object.fromEntries(
      BRIEF_QUERY_KEYS.map((key) => [key, firstString(req.query[key])]),
    )
    const parsed = briefSchema.safeParse(query)
    if (!parsed.success) return sendText(res, 400, describeIssues(parsed.error))
    sendText(res, 200, await service.brief(parsed.data))
  })
}

function checkpointEndpoint(service: SatchelService, logger: Log): RequestHandler {
  return restHandler(logger, async (req, res) => {
    const parsed = checkpointSchema.safeParse(req.body ?? {})
    if (!parsed.success) return sendText(res, 400, describeIssues(parsed.error))
    await service.checkpoint(parsed.data, restClient(req))
    res.status(204).end()
  })
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function errorHandler(logger: Log): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const status = statusOf(error)
    if (status !== undefined && status >= CLIENT_ERROR_MIN && status <= CLIENT_ERROR_MAX) {
      return sendText(res, status, 'bad request')
    }
    logger.error('unhandled request error', { path: req.path, error: String(error) })
    sendText(res, 500, 'internal error')
  }
}

export function createApp(options: AppOptions): Express {
  const { store, authenticate, log: logger, version } = options
  const service = createSatchelService({ store })
  const mcp = createMcpHandler({ store, service, log: logger, version })
  const app = express()

  app.disable('x-powered-by')
  if (options.loopbackHostsOnly) app.use(localhostHostValidation())
  app.get('/healthz', (_req, res) => sendText(res, 200, 'ok'))

  app.use(authenticate)
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }))

  app.post('/mcp', mcp.post)
  app.get('/mcp', mcp.methodNotAllowed)
  app.delete('/mcp', mcp.methodNotAllowed)
  app.get('/api/brief', briefEndpoint(service, logger))
  app.post('/api/checkpoint', checkpointEndpoint(service, logger))

  app.use((_req, res) => sendText(res, 404, 'not found'))
  app.use(errorHandler(logger))
  return app
}
