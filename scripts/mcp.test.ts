import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/auth/auth.ts'
import type { log } from '../src/log.ts'
import { createApp } from '../src/server/app.ts'
import { createFakeStore } from '../src/server/fake-store.ts'
import { formatInstructions, formatTools, parseCli, resultText, runMcp, USAGE } from './mcp.ts'
import type { SandboxState } from './sandbox.ts'

const TOKEN = 'test-token'

const silentLog: typeof log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp({
    store: createFakeStore({
      core: 'Prefer pnpm.',
      topics: { svelte: { trigger: 'read before Svelte work' } },
    }),
    authenticate: createAuthMiddleware({ auth: { token: TOKEN, none: false } }),
    log: silentLog,
    version: '0.0.0-test',
  })
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP address')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function capture() {
  const chunks: string[] = []
  return { write: (text: string) => void chunks.push(text), output: () => chunks.join('') }
}

const noSandbox = async (): Promise<SandboxState | undefined> => undefined

describe('parseCli', () => {
  it('shows the usage with no arguments or with --help', () => {
    expect(parseCli([]).command.kind).toBe('help')
    expect(parseCli(['--help']).command.kind).toBe('help')
  })

  it('turns --list and a tool name into server commands', () => {
    expect(parseCli(['--list']).command.kind).toBe('server')
    expect(parseCli(['brief', '{"project":"p"}']).command.kind).toBe('server')
  })

  it('reads connection flags', () => {
    const cli = parseCli(['--url', 'http://x', '--token', 't', '--client', 'me', '--list'])
    expect(cli).toMatchObject({ url: 'http://x', token: 't', client: 'me' })
  })
})

describe('formatting', () => {
  it('labels instructions and tools with their character counts', () => {
    expect(formatInstructions('abc')).toBe('--- instructions (3 chars)\nabc\n')
    const tools = formatTools([
      { name: 'a', description: 'xy', inputSchema: { type: 'object' } },
      { name: 'b', description: 'zzz', inputSchema: { type: 'object' } },
    ])
    expect(tools).toContain('--- a (2 chars)\nxy\n')
    expect(tools.endsWith('--- 2 tools, 5 description chars\n')).toBe(true)
  })

  it('keeps tool result text as the model reads it, flagging errors', () => {
    expect(resultText({ content: [{ type: 'text', text: 'hi' }] })).toEqual({
      text: 'hi',
      isError: false,
    })
    expect(resultText({ content: [{ type: 'text', text: 'no' }], isError: true }).isError).toBe(
      true,
    )
  })
})

describe('runMcp', () => {
  const state: { base: string; close?: () => Promise<void> } = { base: '' }
  const flags = () => ['--url', state.base, '--token', TOKEN]
  beforeAll(async () => {
    const server = await startServer()
    state.base = server.base
    state.close = server.close
  })
  afterAll(() => state.close?.())

  it('prints usage and exits 0 for --help', async () => {
    const out = capture()
    expect(await runMcp({ argv: ['--help'], readState: noSandbox, write: out.write })).toBe(0)
    expect(out.output()).toBe(USAGE)
  })

  it('lists the tools with their descriptions', async () => {
    const out = capture()
    const code = await runMcp({ argv: [...flags(), '--list'], readState: noSandbox, ...out })
    expect(code).toBe(0)
    expect(out.output()).toMatch(/^--- brief \(\d+ chars\)$/m)
    expect(out.output()).toContain('--- 7 tools,')
  })

  it('prints the instructions, then the result of one call', async () => {
    const out = capture()
    const code = await runMcp({ argv: [...flags(), 'brief', '{}'], readState: noSandbox, ...out })
    expect(code).toBe(0)
    expect(out.output()).toMatch(
      /^--- instructions \(\d+ chars\)\nSatchel is your long-term memory/,
    )
    expect(out.output()).toMatch(/^--- result \(\d+ chars\)\n## Core\nPrefer pnpm\.$/m)
  })

  it('exits 1 when the tool reports an error', async () => {
    const out = capture()
    const code = await runMcp({ argv: [...flags(), 'recall', '{}'], readState: noSandbox, ...out })
    expect(code).toBe(1)
    expect(out.output()).toContain('--- result, error (')
  })

  it('uses the running sandbox when no --url is given', async () => {
    const out = capture()
    const sandbox = async () => ({ url: state.base, token: TOKEN, dataDir: '/unused' })
    expect(await runMcp({ argv: ['--list'], readState: sandbox, ...out })).toBe(0)
  })

  it('exits 2 with the usage for invocation mistakes', async () => {
    const cases = [
      { argv: ['--list'], message: 'no sandbox is running' },
      { argv: [...flags(), 'recall', '{oops'], message: 'tool arguments:' },
      { argv: [...flags(), 'recall', '[1]'], message: 'must be a JSON object' },
      { argv: [...flags(), 'recall', '{}', 'extra'], message: 'one JSON string' },
      { argv: ['--nope'], message: '--nope' },
    ]
    for (const { argv, message } of cases) {
      const out = capture()
      expect(await runMcp({ argv, readState: noSandbox, ...out })).toBe(2)
      expect(out.output()).toContain(message)
      expect(out.output()).toContain(USAGE)
    }
  })

  it('fails with the server address when it cannot connect', async () => {
    const out = capture()
    const argv = ['--url', state.base, '--token', 'wrong', '--list']
    await expect(runMcp({ argv, readState: noSandbox, ...out })).rejects.toThrow(
      `could not connect to ${state.base}/mcp`,
    )
  })
})
