// pnpm sandbox: the real server on a free loopback port, against a temporary data directory
// seeded from fixtures/memories/. See docs/design.md, "Feedback loop for agents".
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CONFIG_VARIABLES } from '../src/config.ts'
import { log } from '../src/log.ts'
import { createGitRepo } from '../src/store/git-repo.ts'

export const SANDBOX_STATE_FILE = fileURLToPath(
  new URL('../.satchel-sandbox.json', import.meta.url),
)
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/memories', import.meta.url))
const MAIN_PATH = fileURLToPath(new URL('../src/main.ts', import.meta.url))
// Shared with `pnpm dev`, so the embedding model downloads once, not once per sandbox.
const MODELS_DIR = fileURLToPath(new URL('../models', import.meta.url))

const LOOPBACK = '127.0.0.1'
const TOKEN_BYTES = 16
const READY_TIMEOUT_MS = 1000 * 30
const READY_POLL_MS = 200
const STOP_TIMEOUT_MS = 1000 * 15

export interface SandboxState {
  url: string
  token: string
  dataDir: string
}

export interface Sandbox {
  state: SandboxState
  /** Resolves with the server's exit code once it stops, for whatever reason. */
  exited: Promise<number | null>
  /** Stops the server and removes the data directory unless `keep`. Safe to call twice. */
  dispose(): Promise<void>
}

export interface SandboxOptions {
  fixturesDir: string
  keep: boolean
  embed: boolean
  logs: 'inherit' | 'ignore'
}

/** Copies the fixtures into `<dataDir>/repo` and commits them, as a real data repo would be. */
export async function seedDataDir(options: { fixturesDir: string; dataDir: string }) {
  const repoDir = join(options.dataDir, 'repo')
  await cp(options.fixturesDir, repoDir, { recursive: true })
  const repo = createGitRepo({ dir: repoDir })
  await repo.ensureInitialised()
  await repo.commit({ paths: ['.'], message: 'seed: fixtures/memories' })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/** The server's environment: token auth on loopback only, whatever the caller's shell sets. */
function serverEnv(options: { dataDir: string; port: number; token: string; embed: boolean }) {
  const noFileVariables = CONFIG_VARIABLES.flatMap((name) => [
    [`${name}_FILE`, ''],
    [`FILE__${name}`, ''],
  ])
  const overrides = Object.fromEntries([
    ...noFileVariables,
    ['SATCHEL_DATA', options.dataDir],
    ['SATCHEL_MODELS', MODELS_DIR],
    ['SATCHEL_HOST', LOOPBACK],
    ['SATCHEL_PORT', String(options.port)],
    ['SATCHEL_TOKEN', options.token],
    ['SATCHEL_EMBED_MODEL', options.embed ? (process.env.SATCHEL_EMBED_MODEL ?? '') : 'off'],
    ['SATCHEL_AUTH', ''],
    ['CF_ACCESS_TEAM_DOMAIN', ''],
    ['CF_ACCESS_AUD', ''],
  ])
  return { ...process.env, ...overrides }
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

async function isHealthy(url: string): Promise<boolean> {
  return fetch(`${url}/healthz`).then(
    (response) => response.ok,
    () => false,
  )
}

async function waitUntilHealthy(options: { url: string; hasExited: () => boolean }) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!options.hasExited() && Date.now() < deadline && !(await isHealthy(options.url))) {
    await delay(READY_POLL_MS)
  }
  if (options.hasExited()) throw new Error('the server exited during startup')
  if (!(await isHealthy(options.url))) throw new Error('the server did not become healthy in time')
}

async function stopChild(options: { child: ChildProcess; exited: Promise<number | null> }) {
  const { child, exited } = options
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timedOut = delay(STOP_TIMEOUT_MS).then(() => 'timeout' as const)
  if ((await Promise.race([exited, timedOut])) === 'timeout') child.kill('SIGKILL')
  await exited
}

export async function startSandbox(options: SandboxOptions): Promise<Sandbox> {
  const dataDir = await mkdtemp(join(tmpdir(), 'satchel-sandbox-'))
  await seedDataDir({ fixturesDir: options.fixturesDir, dataDir })

  const port = await freePort()
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const child = spawn(process.execPath, ['--experimental-strip-types', MAIN_PATH], {
    env: serverEnv({ dataDir, port, token, embed: options.embed }),
    stdio: ['ignore', options.logs, options.logs],
  })
  const exited = exitOf(child)
  const flags = { exited: false }
  void exited.then(() => {
    flags.exited = true
  })

  const disposal: { done?: Promise<void> } = {}
  const dispose = () => {
    disposal.done ??= (async () => {
      await stopChild({ child, exited })
      if (!options.keep) await rm(dataDir, { recursive: true, force: true })
    })()
    return disposal.done
  }

  const url = `http://${LOOPBACK}:${port}`
  try {
    await waitUntilHealthy({ url, hasExited: () => flags.exited })
  } catch (error) {
    await dispose()
    throw error
  }
  return { state: { url, token, dataDir }, exited, dispose }
}

function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}

function parseState(raw: string): SandboxState | undefined {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const url = stringField(parsed, 'url')
  const token = stringField(parsed, 'token')
  const dataDir = stringField(parsed, 'dataDir')
  if (url === undefined || token === undefined || dataDir === undefined) return undefined
  return { url, token, dataDir }
}

/** The running sandbox's address and token, or undefined when none was started. */
export async function readSandboxState(
  path = SANDBOX_STATE_FILE,
): Promise<SandboxState | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    return parseState(raw)
  } catch {
    return undefined
  }
}

function banner(state: SandboxState, keep: boolean): string {
  return [
    'Satchel sandbox running.',
    `  URL:    ${state.url}`,
    `  Token:  ${state.token}`,
    `  Data:   ${state.dataDir} (${keep ? 'kept' : 'removed'} on exit)`,
    'Try `pnpm mcp --list` or `pnpm mcp brief`. Stop with Ctrl-C.',
    '',
  ].join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      keep: { type: 'boolean', default: false },
      embed: { type: 'boolean', default: false },
    },
  })
  const keep = values.keep ?? false
  const sandbox = await startSandbox({
    fixturesDir: FIXTURES_DIR,
    keep,
    embed: values.embed ?? false,
    logs: 'inherit',
  })
  await writeFile(SANDBOX_STATE_FILE, `${JSON.stringify(sandbox.state, null, 2)}\n`, {
    mode: 0o600,
  })
  process.stdout.write(banner(sandbox.state, keep))

  const shutdown = { requested: false }
  const finish = async (exitCode: number) => {
    await sandbox.dispose()
    await rm(SANDBOX_STATE_FILE, { force: true })
    process.exit(exitCode)
  }
  const onSignal = () => {
    shutdown.requested = true
    void finish(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal)

  // Ctrl-C reaches the server too, so its exit after a signal is the normal way out.
  const code = await sandbox.exited
  if (shutdown.requested) return
  log.error('sandbox server exited on its own', { code })
  await finish(1)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log.error('sandbox failed', { error: String(error) })
    process.exit(1)
  })
}
