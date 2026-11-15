import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURES_DIR, readSandboxState, seedDataDir, startSandbox } from './sandbox.ts'

const execFileAsync = promisify(execFile)
const SANDBOX_TEST_TIMEOUT_MS = 1000 * 60

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'satchel-sandbox-test-'))
  cleanup.push(dir)
  return dir
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args])
  return stdout
}

describe('seedDataDir', () => {
  it('copies the fixtures into a committed git repository', async () => {
    const dataDir = await tempDir()
    await seedDataDir({ fixturesDir: FIXTURES_DIR, dataDir })
    const repo = join(dataDir, 'repo')
    expect(existsSync(join(repo, 'core.md'))).toBe(true)
    expect(await readdir(join(repo, 'memories'))).toContain('typescript')
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
    expect(await git(repo, ['log', '--format=%s'])).toContain('seed: fixtures/memories')
  })
})

describe('readSandboxState', () => {
  it('reads a state file and rejects missing or malformed ones', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state.json')
    expect(await readSandboxState(path)).toBeUndefined()
    await writeFile(path, '{not json')
    expect(await readSandboxState(path)).toBeUndefined()
    await writeFile(path, JSON.stringify({ url: 'http://x', token: 7 }))
    expect(await readSandboxState(path)).toBeUndefined()
    const state = { url: 'http://x', token: 't', dataDir: '/d' }
    await writeFile(path, JSON.stringify(state))
    expect(await readSandboxState(path)).toEqual(state)
  })
})

describe('startSandbox', () => {
  it(
    'serves the seeded data behind its token, then stops and removes the data',
    async () => {
      const sandbox = await startSandbox({
        fixturesDir: FIXTURES_DIR,
        keep: false,
        embed: false,
        logs: 'ignore',
      })
      const { url, token, dataDir } = sandbox.state
      try {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(await (await fetch(`${url}/healthz`)).text()).toBe('ok')
        expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(401)
        const authorised = await fetch(`${url}/mcp`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        })
        expect(authorised.status).toBe(405)
      } finally {
        await sandbox.dispose()
      }
      expect(existsSync(dataDir)).toBe(false)
      await sandbox.dispose()
    },
    SANDBOX_TEST_TIMEOUT_MS,
  )

  it(
    'keeps the data directory with keep',
    async () => {
      const sandbox = await startSandbox({
        fixturesDir: FIXTURES_DIR,
        keep: true,
        embed: false,
        logs: 'ignore',
      })
      cleanup.push(sandbox.state.dataDir)
      await sandbox.dispose()
      expect(existsSync(join(sandbox.state.dataDir, 'repo', 'core.md'))).toBe(true)
    },
    SANDBOX_TEST_TIMEOUT_MS,
  )
})
