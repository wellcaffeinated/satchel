import { type FSWatcher, watch } from 'node:fs'
import { log } from '../log.ts'

export interface RepoWatcher {
  close(): void
}

function isIgnored(filename: string | null): boolean {
  if (filename === null) return false
  return filename.split(/[\\/]/).some((part) => part === '.git' || part.startsWith('.'))
}

/** Calls `onChange` (debounced) when files under `dir` change. `.git` and dotfiles are ignored. */
export function createRepoWatcher({
  dir,
  debounceMs,
  onChange,
}: {
  dir: string
  debounceMs: number
  onChange: () => void
}): RepoWatcher {
  let timer: NodeJS.Timeout | undefined
  let closed = false

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!closed) onChange()
    }, debounceMs)
  }

  function startWatching(): FSWatcher | undefined {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!isIgnored(filename)) schedule()
      })
      watcher.on('error', (error) => log.warn('repo watcher failed', { error: String(error) }))
      return watcher
    } catch (error) {
      log.warn('cannot watch the repo; direct edits are picked up on restart only', {
        error: String(error),
      })
      return undefined
    }
  }

  const watcher = startWatching()

  return {
    close() {
      closed = true
      clearTimeout(timer)
      watcher?.close()
    },
  }
}
