import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Embedder } from '../embed/index.ts'
import { SatchelError } from '../types.ts'
import { createStore, type SatchelStore } from './store.ts'
import { createConceptEmbedder, createTempDir, createTickingClock, git } from './test-helpers.ts'

const CONCEPTS = [
  ['car', 'automobile', 'vehicle', 'drive'],
  ['bread', 'loaf', 'baking', 'bake'],
  ['svelte', 'binding', 'bindings'],
]

describe('store', () => {
  const temp = createTempDir()
  const opened: SatchelStore[] = []
  const dataDir = () => join(temp.path, 'data')
  const repoDir = () => join(dataDir(), 'repo')

  async function open(options: Partial<Parameters<typeof createStore>[0]> = {}) {
    const store = await createStore({
      dataDir: dataDir(),
      embedModel: 'off',
      watchDebounceMs: 20,
      ...options,
    })
    opened.push(store)
    return store
  }

  const fakeLoader =
    (embedder: Embedder = createConceptEmbedder(CONCEPTS)) =>
    async () =>
      embedder

  async function memorize(store: SatchelStore, text: string, extra = {}) {
    return store.memorize({
      text,
      topic: 'general',
      topicTrigger: 'read before anything',
      source: 'test-client',
      ...extra,
    })
  }

  beforeEach(() => {
    mkdirSync(temp.path, { recursive: true })
  })

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((store) => store.close().catch(() => undefined)))
    rmSync(dataDir(), { recursive: true, force: true })
  })

  describe('first start', () => {
    it('creates a git repo with core.md, topics.yaml and one initial commit', async () => {
      await open()
      expect(readFileSync(join(repoDir(), 'core.md'), 'utf8')).toBe('')
      expect(readFileSync(join(repoDir(), 'topics.yaml'), 'utf8')).toBe('')
      expect(git(repoDir(), 'rev-list', '--count', 'HEAD').trim()).toBe('1')
      expect(git(repoDir(), 'log', '-1', '--format=%an <%ae>').trim()).toBe(
        'satchel <satchel@localhost>',
      )
    })

    it('caps core.md', async () => {
      await open().then((store) => store.close())
      writeFileSync(join(repoDir(), 'core.md'), 'x'.repeat(5000))
      const store = await open()
      expect((await store.core()).length).toBe(4000)
    })
  })

  describe('memorize and recall', () => {
    it('round trips and commits as satchel with the client name', async () => {
      const store = await open()
      const { memory } = await memorize(store, 'Function bindings in Svelte write to the getter.', {
        topic: 'svelte',
        topicTrigger: 'read before writing Svelte',
      })
      expect(memory.id).toMatch(/^m_[a-z2-7]{8}$/)
      const found = await store.recall({ query: 'svelte bindings', client: 'test-client' })
      expect(found.map((m) => m.id)).toEqual([memory.id])
      expect(found[0]?.text).toBe('Function bindings in Svelte write to the getter.')

      const files = readdirSync(join(repoDir(), 'memories', 'svelte'))
      expect(files).toEqual([`function-bindings-in-svelte-write-to-${memory.id}.md`])
      expect(git(repoDir(), 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s').trim()).toMatch(
        /^satchel <satchel@localhost>\|satchel <satchel@localhost>\|.*test-client/,
      )
      expect(await store.topics()).toEqual([
        { name: 'svelte', trigger: 'read before writing Svelte', count: 1 },
      ])
    })

    it('leaves the owner uncommitted edits out of its commits', async () => {
      const store = await open()
      writeFileSync(join(repoDir(), 'core.md'), 'owner edit')
      await memorize(store, 'Something else entirely.')
      expect(git(repoDir(), 'status', '--porcelain').trim()).toBe('M core.md')
    })

    it('rejects an unknown topic and lists the existing ones', async () => {
      const store = await open()
      await memorize(store, 'First fact.', { topic: 'alpha' })
      await memorize(store, 'Second fact.', { topic: 'beta' })
      const error = await store
        .memorize({ text: 'x', topic: 'gamma', source: 'c' })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SatchelError)
      expect((error as SatchelError).code).toBe('unknown_topic')
      expect((error as SatchelError).message).toContain('alpha, beta')
    })

    it.each([
      ['too_long', { text: 'x'.repeat(1501) }],
      ['too_long', { topic: 'a'.repeat(33) }],
      ['invalid', { topic: 'Not Kebab' }],
      ['invalid', { topic: '../escape' }],
      ['invalid', { text: '   ' }],
      ['invalid', { scope: 'project' }],
    ] as const)('rejects bad input with %s', async (code, override) => {
      const store = await open()
      const error = await memorize(store, 'ok text', override).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SatchelError)
      expect((error as SatchelError).code).toBe(code)
    })

    it('replaces in place, keeping id and created', async () => {
      const clock = createTickingClock()
      const store = await open({ now: clock })
      const first = await memorize(store, 'Old wording of the fact.')
      const second = await memorize(store, 'New wording of the fact.', {
        replaces: first.memory.id,
      })
      expect(second.memory.id).toBe(first.memory.id)
      expect(second.memory.created).toBe(first.memory.created)
      expect(second.memory.updated).not.toBe(first.memory.updated)
      const found = await store.recall({ topic: 'general', client: 'c' })
      expect(found.map((m) => m.text)).toEqual(['New wording of the fact.'])
      expect(readdirSync(join(repoDir(), 'memories', 'general'))).toHaveLength(1)
      await expect(memorize(store, 'x', { replaces: 'm_zzzzzzzz' })).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it('moves the file when a replace changes topic', async () => {
      const store = await open()
      const first = await memorize(store, 'A movable fact.', { topic: 'one' })
      await memorize(store, 'A movable fact.', {
        topic: 'two',
        topicTrigger: 'two trigger',
        replaces: first.memory.id,
      })
      expect(
        existsSync(join(repoDir(), 'memories', 'one', `a-movable-fact-${first.memory.id}.md`)),
      ).toBe(false)
      expect((await store.recall({ topic: 'two', client: 'c' })).map((m) => m.id)).toEqual([
        first.memory.id,
      ])
      expect(git(repoDir(), 'status', '--porcelain').trim()).toBe('')
    })

    it('requires a query or a topic', async () => {
      const store = await open()
      await expect(store.recall({ client: 'c' })).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.recall({ query: '  ', client: 'c' })).rejects.toMatchObject({
        code: 'invalid',
      })
    })

    it.each([
      'what\'s "this" -- AND OR NOT NEAR(',
      'foo-bar',
      "* ^ : { } [ ] ( ) ~ \\ ; '",
      'col:value',
      '"unbalanced',
      '日本語 クエリ',
      '',
    ])('survives odd query %j', async (query) => {
      const store = await open()
      await memorize(store, 'foo bar and a quoted "thing".')
      await expect(store.recall({ query, topic: 'general', client: 'c' })).resolves.toBeDefined()
    })

    it('finds stems and hyphenated words', async () => {
      const store = await open()
      await memorize(store, 'The self-hosted servers keep restarting overnight.')
      const found = await store.recall({ query: 'server restart self-hosted', client: 'c' })
      expect(found).toHaveLength(1)
    })

    it('filters by project and ranks the project first', async () => {
      const store = await open()
      await memorize(store, 'Deploy notes for alpha service.', {
        scope: 'project',
        project: 'alpha',
      })
      await memorize(store, 'Deploy notes for beta service.', { scope: 'project', project: 'beta' })
      await memorize(store, 'Deploy notes everywhere.')
      const found = await store.recall({ query: 'deploy notes', project: 'alpha', client: 'c' })
      expect(found.map((m) => m.text)).toEqual([
        'Deploy notes for alpha service.',
        'Deploy notes everywhere.',
      ])
      expect(await store.projectMemoryCount('alpha')).toBe(1)
    })

    it('clamps the limit and logs returned ids', async () => {
      const store = await open()
      const ids = await Promise.all(
        Array.from({ length: 3 }, (_, i) => memorize(store, `Logged fact number ${i}.`)),
      ).then((results) => results.map((r) => r.memory.id))
      const found = await store.recall({ topic: 'general', limit: 2, client: 'logger' })
      expect(found).toHaveLength(2)
      await store.close()
      const db = new DatabaseSync(join(dataDir(), 'index.sqlite'), { readOnly: true })
      const rows = db.prepare('SELECT memory_id, client FROM recall_log').all()
      db.close()
      expect(rows).toHaveLength(2)
      expect(
        rows.every((row) => row.client === 'logger' && ids.includes(String(row.memory_id))),
      ).toBe(true)
    })

    it('reports similar memories with FTS when embeddings are off', async () => {
      const store = await open()
      await memorize(store, 'The staging database password rotates every ninety days.')
      const { similar } = await memorize(store, 'Staging database password rotates every quarter.')
      expect(similar).toHaveLength(1)
      const unrelated = await memorize(store, 'Completely different topic about bread baking.')
      expect(unrelated.similar).toEqual([])
    })

    it('forgets memories and checkpoints, and errors on unknown ids', async () => {
      const store = await open()
      const { memory } = await memorize(store, 'Temporary fact.')
      const cp = await store.checkpoint({ project: 'p', branch: 'b', commit: 'abc', source: 'c' })
      await store.forget(memory.id, 'c')
      await store.forget(cp.id, 'c')
      expect(await store.recall({ topic: 'general', client: 'c' })).toEqual([])
      expect(await store.checkpoints('p')).toEqual([])
      await expect(store.forget(memory.id, 'c')).rejects.toMatchObject({ code: 'not_found' })
      expect(git(repoDir(), 'status', '--porcelain').trim()).toBe('')
    })

    it('serialises concurrent writes into one commit each', async () => {
      const store = await open()
      await Promise.all(
        Array.from({ length: 12 }, (_, i) => memorize(store, `Concurrent fact ${i}.`)),
      )
      expect(git(repoDir(), 'rev-list', '--count', 'HEAD').trim()).toBe('13')
      expect(git(repoDir(), 'status', '--porcelain').trim()).toBe('')
    })
  })

  describe('checkpoints', () => {
    it('upserts per project and branch and keeps the summary when undefined', async () => {
      const store = await open()
      const first = await store.checkpoint({
        project: 'github.com/o/r',
        branch: 'main',
        commit: 'aaa1111',
        summary: 'Did the store.',
        source: 'c',
      })
      const second = await store.checkpoint({
        project: 'github.com/o/r',
        branch: 'main',
        commit: 'bbb2222',
        source: 'c',
      })
      expect(second.id).toBe(first.id)
      expect(second.commit).toBe('bbb2222')
      expect(second.summary).toBe('Did the store.')
      const third = await store.checkpoint({
        project: 'github.com/o/r',
        branch: 'main',
        commit: 'ccc3333',
        summary: 'Rewritten.',
        source: 'c',
      })
      expect(third.summary).toBe('Rewritten.')
      await store.checkpoint({
        project: 'github.com/o/r',
        branch: 'dev',
        commit: 'ddd',
        source: 'c',
      })
      expect(await store.checkpoints('github.com/o/r')).toHaveLength(2)
      expect(await store.checkpoints('github.com/o/r', 'main')).toEqual([third])
      expect(await store.checkpoints('other')).toEqual([])
    })

    it('drops a checkpoint and tolerates dropping a missing one', async () => {
      const store = await open()
      await store.checkpoint({ project: 'p', branch: 'b', commit: 'abc', source: 'c' })
      await store.dropCheckpoint('p', 'b', 'c')
      await store.dropCheckpoint('p', 'b', 'c')
      expect(await store.checkpoints('p')).toEqual([])
    })

    it.each([
      ['../../x', 'main'],
      ['proj', 'feat/a/b'],
      ['proj', '../../../etc/passwd'],
      ['/abs/olute', '..'],
      ['..', '.'],
      ['proj', '.git/config'],
    ])('keeps %j @ %j inside checkpoints/', async (project, branch) => {
      const store = await open()
      const written = await store.checkpoint({ project, branch, commit: 'abc', source: 'c' })
      await store.close()
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
        )
      const checkpointFiles = walk(join(repoDir(), 'checkpoints'))
      expect(checkpointFiles).toHaveLength(1)
      expect(readdirSync(temp.path)).toEqual(['data'])
      expect(readdirSync(dataDir()).filter((name) => !name.startsWith('index.sqlite'))).toEqual([
        'repo',
      ])
      expect(readdirSync(repoDir()).sort()).toEqual([
        '.git',
        'checkpoints',
        'core.md',
        'topics.yaml',
      ])
      const reopened = await open()
      expect(await reopened.checkpoints(project, branch)).toEqual([written])
    })

    it('keeps lossy-slug branches distinct', async () => {
      const store = await open()
      await store.checkpoint({
        project: 'p',
        branch: 'feat/a',
        commit: '1',
        summary: 'slash',
        source: 'c',
      })
      await store.checkpoint({
        project: 'p',
        branch: 'feat-a',
        commit: '2',
        summary: 'dash',
        source: 'c',
      })
      expect((await store.checkpoints('p')).map((c) => c.summary).sort()).toEqual(['dash', 'slash'])
    })
  })

  describe('index as a rebuildable cache', () => {
    it('rebuilds from the files after index.sqlite is deleted', async () => {
      const first = await open()
      const { memory } = await memorize(first, 'Persistent fact about kettles.')
      await first.checkpoint({
        project: 'p',
        branch: 'b',
        commit: 'abc',
        summary: 's',
        source: 'c',
      })
      await first.close()
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(join(dataDir(), `index.sqlite${suffix}`), { force: true })
      const second = await open()
      expect((await second.recall({ query: 'kettles', client: 'c' })).map((m) => m.id)).toEqual([
        memory.id,
      ])
      expect(await second.checkpoints('p', 'b')).toHaveLength(1)
      expect(await second.topics()).toEqual([
        { name: 'general', trigger: 'read before anything', count: 1 },
      ])
    })

    it('recovers from a corrupt index.sqlite', async () => {
      const first = await open()
      await memorize(first, 'Survives corruption.')
      await first.close()
      for (const suffix of ['-wal', '-shm'])
        rmSync(join(dataDir(), `index.sqlite${suffix}`), { force: true })
      writeFileSync(join(dataDir(), 'index.sqlite'), 'this is not a database'.repeat(100))
      const second = await open()
      expect(await second.recall({ query: 'corruption', client: 'c' })).toHaveLength(1)
    })

    it('picks up direct edits, additions and deletions by the owner', async () => {
      const store = await open()
      await memorize(store, 'Seed fact.')
      const dir = join(repoDir(), 'memories', 'general')
      const handmade = join(dir, 'handmade-m_abcdefgh.md')
      writeFileSync(
        handmade,
        '---\nid: m_abcdefgh\ntopic: general\nscope: global\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\nsource: owner\n---\nThe owner typed a zeppelin fact.\n',
      )
      await vi.waitFor(async () => {
        expect(await store.recall({ query: 'zeppelin', client: 'c' })).toHaveLength(1)
      })
      writeFileSync(handmade, readFileSync(handmade, 'utf8').replace('zeppelin', 'blimp'))
      await vi.waitFor(async () => {
        expect(await store.recall({ query: 'blimp', client: 'c' })).toHaveLength(1)
        expect(await store.recall({ query: 'zeppelin', client: 'c' })).toHaveLength(0)
      })
      rmSync(handmade)
      await vi.waitFor(async () => {
        expect(await store.recall({ query: 'blimp', client: 'c' })).toHaveLength(0)
      })
    })

    it('skips malformed files and keeps working', async () => {
      const first = await open()
      await memorize(first, 'Good fact about telescopes.')
      await first.close()
      const dir = join(repoDir(), 'memories', 'general')
      writeFileSync(join(dir, 'no-frontmatter.md'), 'just text')
      writeFileSync(join(dir, 'bad-yaml.md'), '---\n: : [\n---\nbody')
      writeFileSync(
        join(dir, 'bad-id.md'),
        '---\nid: nope\ntopic: general\ncreated: 2026-01-01T00:00:00Z\n---\nbody',
      )
      writeFileSync(join(repoDir(), 'topics.yaml'), 'this: [is, not: valid')
      const second = await open()
      expect(await second.recall({ query: 'telescopes', client: 'c' })).toHaveLength(1)
      expect(await second.topics()).toEqual([{ name: 'general', trigger: '', count: 1 }])
    })

    it('skips a duplicate id instead of crashing', async () => {
      const store = await open()
      const { memory } = await memorize(store, 'Original fact about lanterns.')
      const dir = join(repoDir(), 'memories', 'general')
      const [file] = readdirSync(dir)
      writeFileSync(join(dir, 'copy.md'), readFileSync(join(dir, file ?? ''), 'utf8'))
      await store.sync()
      expect((await store.recall({ query: 'lanterns', client: 'c' })).map((m) => m.id)).toEqual([
        memory.id,
      ])
    })
  })

  describe('embeddings', () => {
    const paraphrase = 'automobile vehicle'

    it('is usable full-text-only until the model loads, then ranks by meaning', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const embedder = createConceptEmbedder(CONCEPTS)
      const store = await open({
        embedModel: 'fake-a',
        embedderLoader: async () => {
          await gate
          return embedder
        },
      })
      await memorize(store, 'Always drive the car carefully on ice.', {
        topic: 'cars',
        topicTrigger: 't',
      })
      await memorize(store, 'Bake the bread loaf at a lower heat.', {
        topic: 'food',
        topicTrigger: 't',
      })
      expect(await store.recall({ query: paraphrase, client: 'c' })).toEqual([])
      expect(await store.recall({ query: 'ice', client: 'c' })).toHaveLength(1)

      release()
      await store.embeddingsIdle()
      const found = await store.recall({ query: paraphrase, client: 'c' })
      expect(found.map((m) => m.topic)).toEqual(['cars'])
    })

    it('fuses full-text and vector rankings', async () => {
      const store = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader() })
      await store.embeddingsIdle()
      await memorize(store, 'Drive carefully: an automobile needs winter tyres.', {
        topic: 'cars',
        topicTrigger: 't',
      })
      await memorize(store, 'Notes on vehicle taxes and a loaf of bread.', {
        topic: 'misc',
        topicTrigger: 't',
      })
      await memorize(store, 'Bake the bread loaf at a lower heat.', {
        topic: 'food',
        topicTrigger: 't',
      })
      const found = await store.recall({ query: 'vehicle automobile drive', client: 'c' })
      expect(found[0]?.topic).toBe('cars')
      expect(found.map((m) => m.topic)).not.toContain('food')
    })

    it('reports similar memories by vector', async () => {
      const store = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader() })
      await store.embeddingsIdle()
      await memorize(store, 'The automobile needs winter tyres.')
      const { similar } = await memorize(store, 'Vehicle tyres must be changed for winter.')
      expect(similar).toHaveLength(1)
    })

    it('falls back to full text when the model fails to load', async () => {
      const store = await open({
        embedModel: 'broken',
        embedderLoader: async () => {
          throw new Error('offline')
        },
      })
      await memorize(store, 'Kettles are great.')
      await store.embeddingsIdle()
      expect(await store.recall({ query: 'kettles', client: 'c' })).toHaveLength(1)
    })

    it('falls back to full text when embedding a query throws', async () => {
      const broken: Embedder = {
        embed: async () => {
          throw new Error('inference failed')
        },
      }
      const store = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader(broken) })
      await store.embeddingsIdle()
      await memorize(store, 'Kettles are great.')
      expect(await store.recall({ query: 'kettles', client: 'c' })).toHaveLength(1)
    })

    function storedModels(): { id: string; model: string }[] {
      const db = new DatabaseSync(join(dataDir(), 'index.sqlite'), { readOnly: true })
      const rows = db.prepare('SELECT id, model FROM vectors ORDER BY id').all()
      db.close()
      return rows.map((row) => ({ id: String(row.id), model: String(row.model) }))
    }

    it('re-embeds everything when the configured model name changes', async () => {
      const first = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader() })
      await first.embeddingsIdle()
      await memorize(first, 'The automobile needs winter tyres.')
      await memorize(first, 'Bake the bread loaf slowly.')
      await first.close()
      expect(storedModels().map((v) => v.model)).toEqual(['fake-a', 'fake-a'])

      const embedder = createConceptEmbedder(CONCEPTS)
      const second = await open({ embedModel: 'fake-b', embedderLoader: fakeLoader(embedder) })
      await second.embeddingsIdle()
      await second.close()
      expect(storedModels().map((v) => v.model)).toEqual(['fake-b', 'fake-b'])
      expect(embedder.calls).toBe(2)
    })

    it('does not re-embed when the model name is unchanged', async () => {
      const first = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader() })
      await first.embeddingsIdle()
      await memorize(first, 'The automobile needs winter tyres.')
      await first.close()
      const embedder = createConceptEmbedder(CONCEPTS)
      const second = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader(embedder) })
      await second.embeddingsIdle()
      expect(embedder.calls).toBe(0)
    })

    it('embeds memories added by direct edits', async () => {
      const store = await open({ embedModel: 'fake-a', embedderLoader: fakeLoader() })
      await store.embeddingsIdle()
      await memorize(store, 'Seed fact.')
      writeFileSync(
        join(repoDir(), 'memories', 'general', 'by-hand-m_abcdefgh.md'),
        '---\nid: m_abcdefgh\ntopic: general\ncreated: 2026-01-01T00:00:00Z\n---\nThe automobile needs winter tyres.\n',
      )
      await vi.waitFor(async () => {
        await store.embeddingsIdle()
        const found = await store.recall({ query: 'vehicle', client: 'c' })
        expect(found.map((m) => m.id)).toEqual(['m_abcdefgh'])
      })
    })
  })

  describe('close', () => {
    it('waits for in-flight writes and rejects later ones', async () => {
      const store = await open()
      const pending = memorize(store, 'In flight when closing.')
      await store.close()
      await expect(pending).resolves.toBeDefined()
      await expect(memorize(store, 'Too late.')).rejects.toThrow('closed')
      expect(git(repoDir(), 'status', '--porcelain').trim()).toBe('')
    })
  })
})
