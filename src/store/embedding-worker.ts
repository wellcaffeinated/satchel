import type { Embedder, EmbedderLoader } from '../embed/index.ts'
import type { SearchIndex } from '../index/index.ts'
import { log } from '../log.ts'
import { leadParagraph } from './memory-files.ts'

const BACKFILL_BATCH_SIZE = 16

export interface ModelVector {
  model: string
  vector: Float32Array
}

export interface EmbeddingWorker {
  /** Starts loading the model in the background. Never throws. */
  start(): void
  queryVector(text: string): Promise<ModelVector | undefined>
  passageVector(text: string): Promise<ModelVector | undefined>
  /** Embeds, in the background, every memory lacking a vector from the configured model. */
  kick(): void
  /** Resolves when the model load has settled and no backfill is running. */
  whenIdle(): Promise<void>
  stop(): Promise<void>
}

export function createEmbeddingWorker({
  index,
  model,
  loader,
}: {
  index: SearchIndex
  model: string
  /** Undefined means embeddings are off. */
  loader: EmbedderLoader | undefined
}): EmbeddingWorker {
  let embedder: Embedder | undefined
  let loading: Promise<void> = Promise.resolve()
  let backfill: Promise<void> | undefined
  let stopped = false

  async function vectorFor(text: string, kind: 'query' | 'passage') {
    if (!embedder) return undefined
    try {
      const [vector] = await embedder.embed([text], kind)
      return vector ? { model, vector } : undefined
    } catch (error) {
      log.warn('embedding failed, falling back to full-text only', { error: String(error) })
      return undefined
    }
  }

  async function embedPending(active: Embedder) {
    const nextBatch = () => index.pendingEmbeddings({ model, limit: BACKFILL_BATCH_SIZE })
    let pending = nextBatch()
    while (pending.length > 0 && !stopped) {
      const vectors = await active.embed(
        pending.map((item) => leadParagraph(item.text)),
        'passage',
      )
      if (vectors.length !== pending.length) throw new Error('embedder returned the wrong count')
      for (const [position, item] of pending.entries()) {
        const vector = vectors[position]
        if (vector && !stopped)
          index.setVector({ id: item.id, model, textHash: item.textHash, vector })
      }
      pending = nextBatch()
    }
  }

  function kick() {
    const active = embedder
    if (!active || backfill || stopped) return
    backfill = embedPending(active)
      .catch((error) => log.warn('re-embedding stopped', { error: String(error) }))
      .finally(() => {
        backfill = undefined
      })
  }

  function start() {
    if (!loader) return
    loading = loader()
      .then((loaded) => {
        embedder = loaded
        log.info('embedding model ready', { model })
        kick()
      })
      .catch((error) =>
        log.warn('embedding model unavailable, using full-text search only', {
          model,
          error: String(error),
        }),
      )
  }

  async function whenIdle() {
    await loading
    while (backfill) await backfill
  }

  async function stop() {
    stopped = true
    await whenIdle()
  }

  return {
    start,
    queryVector: (text) => vectorFor(text, 'query'),
    passageVector: (text) => vectorFor(text, 'passage'),
    kick,
    whenIdle,
    stop,
  }
}
