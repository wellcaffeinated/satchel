import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Embedder } from '../embed/index.ts'

const WORD = /[a-z0-9]+/g

/** A fake embedder: each group of words is one dimension, so synonyms share a direction. */
export function createConceptEmbedder(concepts: string[][]): Embedder & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    async embed(texts) {
      state.calls += texts.length
      return texts.map((text) => {
        const words = text.toLowerCase().match(WORD) ?? []
        const vector = concepts.map((group) => words.filter((word) => group.includes(word)).length)
        return Float32Array.from([...vector, 0.01])
      })
    },
  }
}

export function createTempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'satchel-test-'))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

export function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
}

/** A clock that advances one second per reading. */
export function createTickingClock(): () => Date {
  const readings = { count: 0 }
  return () => {
    readings.count += 1
    return new Date(Date.UTC(2026, 10, 12, 18, 0, readings.count))
  }
}
