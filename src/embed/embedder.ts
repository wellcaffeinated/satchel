// The only thing the rest of satchel knows about embeddings. Tests pass a fake.

export type EmbedKind = 'query' | 'passage'

export interface Embedder {
  /** One vector per input text, in order. */
  embed(texts: string[], kind?: EmbedKind): Promise<Float32Array[]>
}

/** Loads (and if needed downloads) a model. May take a long time or reject. */
export type EmbedderLoader = () => Promise<Embedder>
