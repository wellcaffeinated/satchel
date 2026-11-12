import type { Embedder, EmbedderLoader, EmbedKind } from './embedder.ts'

export type Pooling = 'cls' | 'mean'

export interface FeatureTensor {
  data: Float32Array
  dims: number[]
}

export type FeatureExtractor = (
  texts: string[],
  options: { pooling: Pooling; normalize: boolean },
) => Promise<FeatureTensor>

export interface LoadExtractorInput {
  model: string
  cacheDir: string
}

const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
const BGE_MODEL = /bge/i
const MULTILINGUAL_BGE_MODEL = /m3/i

async function loadExtractorFromHub({
  model,
  cacheDir,
}: LoadExtractorInput): Promise<FeatureExtractor> {
  const transformers = await import('@huggingface/transformers')
  transformers.env.cacheDir = cacheDir
  transformers.env.allowRemoteModels = true
  const extractor = await transformers.pipeline('feature-extraction', model)
  return async (texts, options) => {
    const { data, dims } = await extractor(texts, options)
    if (!(data instanceof Float32Array)) throw new Error('embedding model returned non-float data')
    return { data, dims }
  }
}

export interface HuggingFaceLoaderOptions {
  model: string
  cacheDir: string
  /** Injected so tests need no model; defaults to the real library. */
  loadExtractor?: (input: LoadExtractorInput) => Promise<FeatureExtractor>
}

/** Loader backed by `@huggingface/transformers`, caching the model under `cacheDir`. */
export function createHuggingFaceLoader({
  model,
  cacheDir,
  loadExtractor = loadExtractorFromHub,
}: HuggingFaceLoaderOptions): EmbedderLoader {
  const isBge = BGE_MODEL.test(model)
  const pooling: Pooling = isBge ? 'cls' : 'mean'
  const queryPrefix = isBge && !MULTILINGUAL_BGE_MODEL.test(model) ? BGE_QUERY_PREFIX : ''
  const prefixFor: Record<EmbedKind, string> = { query: queryPrefix, passage: '' }

  return async (): Promise<Embedder> => {
    const extractor = await loadExtractor({ model, cacheDir })
    // onnxruntime sessions are not meant to be driven concurrently: run one batch at a time.
    let queue: Promise<unknown> = Promise.resolve()

    async function embedBatch(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
      const inputs = texts.map((text) => prefixFor[kind] + text)
      const { data, dims } = await extractor(inputs, { pooling, normalize: true })
      const dimension = dims.at(-1) ?? 0
      return inputs.map((_, index) => data.slice(index * dimension, (index + 1) * dimension))
    }

    return {
      embed(texts, kind = 'passage') {
        if (texts.length === 0) return Promise.resolve([])
        const run = queue.then(() => embedBatch(texts, kind))
        queue = run.catch(() => undefined)
        return run
      },
    }
  }
}
