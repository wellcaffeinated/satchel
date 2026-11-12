// biome-ignore-all lint/style/useNamingConvention: HTTP header and tool argument names are fixed by docs/design.md
import type { Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../auth/auth.ts'
import { INSTRUCTIONS_MAX_CHARS } from '../config.ts'
import type { log } from '../log.ts'
import type { Memory, Topic } from '../types.ts'
import { createApp } from './app.ts'
import { createFakeStore, type FakeStore, type FakeStoreSeed } from './fake-store.ts'

const TOKEN = 'test-token'
const AUTH_HEADERS = { Authorization: `Bearer ${TOKEN}` }

const silentLog: typeof log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function memory(overrides: Partial<Memory> & Pick<Memory, 'id' | 'topic' | 'text'>): Memory {
  return {
    scope: 'global',
    created: '2026-11-01T10:00:00Z',
    updated: '2026-11-01T10:00:00Z',
    source: 'seed',
    ...overrides,
  }
}

const SEED: FakeStoreSeed = {
  core: 'The owner prefers pnpm over npm.',
  topics: {
    svelte: { trigger: 'read before writing Svelte components' },
    docker: { trigger: 'read before editing Dockerfiles' },
  },
  memories: [
    memory({ id: 'm_aaaaaaaa', topic: 'svelte', text: 'Svelte 5 bindings write to the getter.' }),
    memory({
      id: 'm_bbbbbbbb',
      topic: 'docker',
      scope: 'project',
      project: 'github.com/me/app',
      text: 'The app image needs the onnx runtime.',
    }),
  ],
  checkpoints: [
    {
      id: 'c_cccccccc',
      project: 'github.com/me/app',
      branch: 'main',
      commit: '3f2a9c1',
      updated: '2026-11-12T18:04:00Z',
      source: 'claude-code',
      summary: 'Store done. Next: recall logging.',
    },
  ],
}

interface Harness {
  base: string
  store: FakeStore
  close: () => Promise<void>
}

async function start(seed: FakeStoreSeed = SEED): Promise<Harness> {
  const store = createFakeStore(seed)
  const app = createApp({
    store,
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
    store,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function connect(base: string, name = 'test-client'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: AUTH_HEADERS },
  })
  await client.connect(transport)
  return client
}

function textOf(result: unknown): string {
  const { content } = CallToolResultSchema.parse(result)
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

function isError(result: unknown): boolean {
  return CallToolResultSchema.parse(result).isError === true
}

describe('MCP over Streamable HTTP', () => {
  const state: { harness?: Harness; client?: Client } = {}
  const harness = () => {
    if (!state.harness) throw new Error('not started')
    return state.harness
  }
  const client = () => {
    if (!state.client) throw new Error('not connected')
    return state.client
  }

  beforeAll(async () => {
    state.harness = await start()
    state.client = await connect(state.harness.base)
  })
  afterAll(async () => {
    await state.client?.close()
    await state.harness?.close()
  })

  it('returns instructions with rules and the live topic map', () => {
    const instructions = client().getInstructions() ?? ''
    expect(instructions).toContain('Call `brief` once at the start')
    expect(instructions).toContain('- svelte (1): read before writing Svelte components')
    expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS)
  })

  it('lists five tools with annotations and tight descriptions', async () => {
    const { tools } = await client().listTools()
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'brief',
      'checkpoint',
      'forget',
      'recall',
      'remember',
    ])
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeLessThan(1000)
    }
    const brief = tools.find((tool) => tool.name === 'brief')
    expect(brief?.description).toMatch(/start of every conversation/)
    expect(brief?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((tool) => tool.name === 'forget')?.annotations?.destructiveHint).toBe(true)
  })

  it('brief returns core, topics and the project checkpoint as a claim', async () => {
    const result = await client().callTool({
      name: 'brief',
      arguments: { project: 'github.com/me/app', branch: 'main' },
    })
    const text = textOf(result)
    expect(isError(result)).toBe(false)
    expect(text).toContain('The owner prefers pnpm')
    expect(text).toContain('- docker (1)')
    expect(text).toMatch(/^checkpoint-commit: 3f2a9c1$/m)
    expect(text).toContain('Project memories: 1')
    expect(text).toMatch(/compare commit 3f2a9c1 with the repo/)
  })

  it('recall returns one line per memory and logs the client', async () => {
    const result = await client().callTool({ name: 'recall', arguments: { topic: 'svelte' } })
    expect(textOf(result)).toBe(
      '- m_aaaaaaaa [svelte | global | 2026-11-01] Svelte 5 bindings write to the getter.',
    )
    expect(harness().store.recallLog).toContainEqual({ id: 'm_aaaaaaaa', client: 'test-client' })
  })

  it('recall without query or topic is an error result', async () => {
    const result = await client().callTool({ name: 'recall', arguments: {} })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('`query`, `topic`')
  })

  it('recall of an unknown topic surfaces the store error as isError', async () => {
    const result = await client().callTool({ name: 'recall', arguments: { topic: 'nope' } })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('Unknown topic "nope"')
    expect(textOf(result)).toContain('svelte')
  })

  it('remember saves with the MCP client name as source and reports similar memories', async () => {
    const result = await client().callTool({
      name: 'remember',
      arguments: { text: 'Use $state.raw for large arrays.', topic: 'svelte' },
    })
    const text = textOf(result)
    expect(isError(result)).toBe(false)
    expect(text).toMatch(/^Saved:\n- m_\w{8} \[svelte \| global \| 2026-11-12\]/)
    expect(text).toContain('m_aaaaaaaa')
    const saved = [...harness().store.memories.values()].find((m) => m.text.includes('$state.raw'))
    expect(saved?.source).toBe('test-client')
  })

  it('remember with an unknown topic and no trigger lists existing topics', async () => {
    const result = await client().callTool({
      name: 'remember',
      arguments: { text: 'A fact.', topic: 'brand-new' },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toMatch(/Existing topics: .*svelte/)
  })

  it('remember checks scope fields', async () => {
    const result = await client().callTool({
      name: 'remember',
      arguments: { text: 'A fact.', topic: 'svelte', scope: 'project' },
    })
    expect(isError(result)).toBe(true)
    expect(textOf(result)).toContain('needs `project`')
  })

  it('remember rejects a malformed topic name', async () => {
    const result = await client().callTool({
      name: 'remember',
      arguments: { text: 'A fact.', topic: 'Bad Topic', topic_trigger: 'read before x' },
    })
    expect(isError(result)).toBe(true)
  })

  it('checkpoint upserts and done deletes', async () => {
    const saved = await client().callTool({
      name: 'checkpoint',
      arguments: {
        project: 'github.com/me/app',
        branch: 'feat',
        commit: 'abc1234',
        summary: 'WIP',
      },
    })
    expect(textOf(saved)).toMatch(/saved for github.com\/me\/app @ feat at abc1234/)
    const stored = await harness().store.checkpoints('github.com/me/app', 'feat')
    expect(stored[0]?.source).toBe('test-client')
    const done = await client().callTool({
      name: 'checkpoint',
      arguments: { project: 'github.com/me/app', branch: 'feat', commit: 'abc1234', done: true },
    })
    expect(textOf(done)).toContain('removed')
    expect(await harness().store.checkpoints('github.com/me/app', 'feat')).toEqual([])
  })

  it('forget deletes and reports not_found as isError', async () => {
    const ok = await client().callTool({ name: 'forget', arguments: { id: 'm_bbbbbbbb' } })
    expect(textOf(ok)).toBe('Deleted m_bbbbbbbb.')
    const again = await client().callTool({ name: 'forget', arguments: { id: 'm_bbbbbbbb' } })
    expect(isError(again)).toBe(true)
    expect(textOf(again)).toContain('No memory or checkpoint')
  })

  it('hides unexpected store errors behind a generic message', async () => {
    const original = harness().store.core
    harness().store.core = async () => {
      throw new Error('disk on fire at /secret/path')
    }
    const result = await client().callTool({ name: 'brief', arguments: {} })
    harness().store.core = original
    expect(isError(result)).toBe(true)
    expect(textOf(result)).not.toContain('/secret/path')
    expect(textOf(result)).toContain('internal error')
  })
})

describe('instructions cap', () => {
  const state: { harness?: Harness } = {}
  afterEach(() => state.harness?.close())

  it('caps instructions with many topics and points to brief', async () => {
    const topics = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [
        `area-${index}`,
        { trigger: `read before changing subsystem number ${index} of the platform` },
      ]),
    )
    const memories = Array.from({ length: 150 }, (_, index) =>
      memory({ id: `m_${String(index).padStart(8, '0')}`, topic: `area-${index}`, text: 'x' }),
    ).flatMap((m, index) =>
      Array.from({ length: (index % 5) + 1 }, (_, copy) => ({
        ...m,
        id: `m_${String(index * 10 + copy).padStart(8, '0')}`,
      })),
    )
    state.harness = await start({ topics, memories })
    const client = await connect(state.harness.base)
    const instructions = client.getInstructions() ?? ''
    expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS)
    expect(instructions).toMatch(/\+\d+ more topics; call `brief` for the full list\.$/)
    const counts = [...instructions.matchAll(/^- area-\d+ \((\d+)\)/gm)].map((m) => Number(m[1]))
    const shownMinimum = Math.min(...counts)
    const allTopics: Topic[] = await state.harness.store.topics()
    const hidden = allTopics.filter((t) => !instructions.includes(`- ${t.name} (`))
    expect(hidden.every((t) => t.count <= shownMinimum)).toBe(true)
    await client.close()
  })
})

describe('REST and auth', () => {
  const state: { harness?: Harness } = {}
  const base = () => state.harness?.base ?? ''
  beforeAll(async () => {
    state.harness = await start()
  })
  afterAll(() => state.harness?.close())

  it('/healthz needs no auth', async () => {
    const response = await fetch(`${base()}/healthz`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('every other route returns a bare 401 without credentials', async () => {
    for (const path of ['/mcp', '/api/brief', '/api/checkpoint', '/nope']) {
      const response = await fetch(`${base()}${path}`, { method: 'POST' })
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('')
    }
  })

  it('GET /api/brief returns plain text with checkpoint-commit', async () => {
    const response = await fetch(`${base()}/api/brief?project=github.com/me/app&branch=main`, {
      headers: AUTH_HEADERS,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
    const text = await response.text()
    expect(text).toMatch(/^checkpoint-commit: 3f2a9c1$/m)
    expect(text).toContain('The owner prefers pnpm')
  })

  it('POST /api/checkpoint saves with the X-Satchel-Client name and returns 204', async () => {
    const response = await fetch(`${base()}/api/checkpoint`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json', 'x-satchel-client': 'hook' },
      body: JSON.stringify({ project: 'p', branch: 'b', commit: 'abc1234' }),
    })
    expect(response.status).toBe(204)
    const [saved] = (await state.harness?.store.checkpoints('p', 'b')) ?? []
    expect(saved?.source).toBe('hook')
    expect(saved?.summary).toBe('')
  })

  it('POST /api/checkpoint defaults the client to rest and rejects bad bodies', async () => {
    const ok = await fetch(`${base()}/api/checkpoint`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p', branch: 'c', commit: 'abc1234', summary: 's' }),
    })
    expect(ok.status).toBe(204)
    const [saved] = (await state.harness?.store.checkpoints('p', 'c')) ?? []
    expect(saved?.source).toBe('rest')

    const missing = await fetch(`${base()}/api/checkpoint`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p' }),
    })
    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('branch')

    const malformed = await fetch(`${base()}/api/checkpoint`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(malformed.status).toBe(400)
  })

  it('rejects oversized JSON bodies', async () => {
    const response = await fetch(`${base()}/api/checkpoint`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        project: 'p',
        branch: 'b',
        commit: 'a',
        summary: 'x'.repeat(400_000),
      }),
    })
    expect(response.status).toBe(413)
  })

  it('GET and DELETE /mcp are 405 for authenticated callers', async () => {
    expect((await fetch(`${base()}/mcp`, { headers: AUTH_HEADERS })).status).toBe(405)
    const deleted = await fetch(`${base()}/mcp`, { method: 'DELETE', headers: AUTH_HEADERS })
    expect(deleted.status).toBe(405)
  })
})
