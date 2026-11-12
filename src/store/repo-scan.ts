import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Checkpoint, Memory } from '../types.ts'
import { hashContent, parseCheckpoint, parseMemory } from './memory-files.ts'

export type ScannedFile =
  | { kind: 'memory'; path: string; hash: string; memory: Memory }
  | { kind: 'checkpoint'; path: string; hash: string; checkpoint: Checkpoint }
  | { kind: 'malformed'; path: string; hash: string; error: string }

const ROOTS = ['memories', 'checkpoints'] as const

const PARSERS = {
  memories: (path: string, hash: string, raw: string): ScannedFile => ({
    kind: 'memory',
    path,
    hash,
    memory: parseMemory(raw),
  }),
  checkpoints: (path: string, hash: string, raw: string): ScannedFile => ({
    kind: 'checkpoint',
    path,
    hash,
    checkpoint: parseCheckpoint(raw),
  }),
} satisfies Record<(typeof ROOTS)[number], (path: string, hash: string, raw: string) => ScannedFile>

function isVisibleMarkdown(relative: string): boolean {
  return relative.endsWith('.md') && relative.split('/').every((part) => !part.startsWith('.'))
}

async function listMarkdown(repoDir: string, root: string): Promise<string[]> {
  const entries = await readdir(join(repoDir, root), { recursive: true }).catch(() => [])
  return entries
    .map((entry) => entry.split('\\').join('/'))
    .filter(isVisibleMarkdown)
    .map((entry) => `${root}/${entry}`)
    .toSorted()
}

async function scanFile(
  repoDir: string,
  root: (typeof ROOTS)[number],
  path: string,
): Promise<ScannedFile[]> {
  const raw = await readFile(join(repoDir, path), 'utf8').catch(() => undefined)
  if (raw === undefined) return []
  const hash = hashContent(raw)
  try {
    return [PARSERS[root](path, hash, raw)]
  } catch (error) {
    return [{ kind: 'malformed', path, hash, error: String(error) }]
  }
}

/** Reads and parses every memory and checkpoint file under `repoDir`. */
export async function scanRepo(repoDir: string): Promise<ScannedFile[]> {
  const perRoot = await Promise.all(
    ROOTS.map(async (root) => {
      const paths = await listMarkdown(repoDir, root)
      const scanned = await Promise.all(paths.map((path) => scanFile(repoDir, root, path)))
      return scanned.flat()
    }),
  )
  return perRoot.flat()
}
