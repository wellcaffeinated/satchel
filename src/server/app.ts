// The Express app: /healthz (unauthenticated), then auth, then /mcp.
import { localhostHostValidation } from '@modelcontextprotocol/express'
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express'
import { JSON_BODY_LIMIT_BYTES } from '../config.ts'
import type { log } from '../log.ts'
import type { Store } from '../types.ts'
import { createMcpHandler } from './mcp-handler.ts'
import { createSatchelService } from './service.ts'

type Log = typeof log

const CLIENT_ERROR_MIN = 400
const CLIENT_ERROR_MAX = 499

export interface AppOptions {
  store: Store
  authenticate: RequestHandler
  log: Log
  version: string
  /** IANA zone for rendering dates; UTC when absent. */
  timeZone?: string
  /** DNS-rebinding protection (Host must be a loopback name). For unauthenticated loopback use. */
  loopbackHostsOnly?: boolean
}

function sendText(res: express.Response, status: number, text: string) {
  res.status(status).type('text/plain; charset=utf-8').send(text)
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
  const service = createSatchelService({ store, timeZone: options.timeZone })
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

  app.use((_req, res) => sendText(res, 404, 'not found'))
  app.use(errorHandler(logger))
  return app
}
