// Wiring and startup: config, store, app, listen, graceful shutdown.
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createAuthMiddleware } from './auth/auth.ts'
import { authModeNames, type Config, loadConfig } from './config.ts'
import { log } from './log.ts'
import { createApp } from './server/app.ts'
import { createStore } from './store/index.ts'
import type { Store } from './types.ts'

const SHUTDOWN_GRACE_MS = 1000 * 10
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url)

async function packageVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(PACKAGE_JSON_URL, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) return '0.0.0'
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
}

function listen(options: { app: ReturnType<typeof createApp>; config: Config }): Promise<Server> {
  const { app, config } = options
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, (error?: Error) => {
      if (error) return reject(error)
      resolve(server)
    })
  })
}

function boundAddress(server: Server, config: Config): string {
  const address = server.address()
  if (address === null || typeof address === 'string') return `${config.host}:${config.port}`
  return `${address.address}:${address.port}`
}

function installShutdown(options: { server: Server; store: Store }): void {
  const { server, store } = options
  const state = { stopping: false }

  const shutdown = async (signal: string) => {
    if (state.stopping) return
    state.stopping = true
    log.info('shutting down', { signal })
    setTimeout(() => {
      log.warn('shutdown timed out; exiting')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS).unref()
    server.closeIdleConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await store.close()
    log.info('stopped')
    process.exit(0)
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => void shutdown(signal))
  }
}

async function main(): Promise<void> {
  const result = loadConfig(process.env)
  if (!result.ok) {
    log.error(`config: ${result.error}`)
    process.exit(1)
  }
  const { config } = result

  const store = await createStore({ dataDir: config.dataDir, embedModel: config.embedModel })
  const app = createApp({
    store,
    authenticate: createAuthMiddleware({
      auth: config.auth,
      onError: (error) => log.debug('access jwt rejected', { error: String(error) }),
      onReject: (presented) => log.debug('request rejected', { ...presented }),
    }),
    log,
    version: await packageVersion(),
    loopbackHostsOnly: config.auth.none,
  })
  const server = await listen({ app, config })
  installShutdown({ server, store })

  log.info(
    `satchel listening on ${boundAddress(server, config)}, auth: ${authModeNames(config.auth).join(', ')}, data: ${config.dataDir}, embed: ${config.embedModel}`,
  )
}

main().catch((error: unknown) => {
  log.error('startup failed', { error: String(error) })
  process.exit(1)
})
