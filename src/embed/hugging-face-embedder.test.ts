import { describe, expect, it } from 'vitest'
import { createHuggingFaceLoader, type FeatureExtractor } from './hugging-face-embedder.ts'

function fakeExtractor(seen: string[][]): FeatureExtractor {
  return async (texts) => {
    seen.push(texts)
    const data = Float32Array.from(texts.flatMap((_, index) => [index, index + 1]))
    return { data, dims: [texts.length, 2] }
  }
}

function loaderFor(model: string, seen: string[][]) {
  return createHuggingFaceLoader({
    model,
    cacheDir: '/unused',
    loadExtractor: async () => fakeExtractor(seen),
  })
}

describe('createHuggingFaceLoader', () => {
  it('splits the batch tensor into one vector per text', async () => {
    const embedder = await loaderFor('Xenova/all-MiniLM-L6-v2', [])()
    const vectors = await embedder.embed(['a', 'b', 'c'])
    expect(vectors.map((v) => [...v])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
  })

  it('adds the bge query instruction to queries only', async () => {
    const seen: string[][] = []
    const embedder = await loaderFor('Xenova/bge-small-en-v1.5', seen)()
    await embedder.embed(['hello'], 'query')
    await embedder.embed(['hello'], 'passage')
    expect(seen[0]?.[0]).toMatch(/^Represent this sentence/)
    expect(seen[1]).toEqual(['hello'])
  })

  it('returns nothing for no input without touching the model', async () => {
    const seen: string[][] = []
    const embedder = await loaderFor('x/model', seen)()
    expect(await embedder.embed([])).toEqual([])
    expect(seen).toEqual([])
  })

  it('rejects when the model cannot be loaded', async () => {
    const loader = createHuggingFaceLoader({
      model: 'x/model',
      cacheDir: '/unused',
      loadExtractor: async () => {
        throw new Error('offline')
      },
    })
    await expect(loader()).rejects.toThrow('offline')
  })
})
