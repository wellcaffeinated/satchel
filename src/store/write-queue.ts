export interface WriteQueue {
  /** Runs `work` after everything queued before it has finished. Rejects once closed. */
  run<T>(work: () => Promise<T>): Promise<T>
  /** Rejects new work and resolves once all queued work has settled. */
  close(): Promise<void>
  isClosed(): boolean
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false

  function run<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('store is closed'))
    const result = tail.then(work)
    tail = result.catch(() => undefined)
    return result
  }

  async function close() {
    closed = true
    await tail
  }

  return { run, close, isClosed: () => closed }
}
