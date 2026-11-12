import { readFile } from 'node:fs/promises'
import { Document, parse, parseDocument } from 'yaml'
import { log } from '../log.ts'

export interface TopicsFile {
  /** topic name -> trigger. Malformed content reads as empty, with a warning. */
  read(): Promise<Map<string, string>>
  /** The new file content with `name` added, comments preserved. */
  withTopic(input: { name: string; trigger: string }): Promise<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function triggerOf(entry: unknown): string {
  if (!isRecord(entry)) return ''
  return typeof entry.trigger === 'string' ? entry.trigger : ''
}

async function readRaw(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '')
}

export function createTopicsFile({ path }: { path: string }): TopicsFile {
  async function read() {
    const raw = await readRaw(path)
    try {
      const data: unknown = parse(raw)
      if (data === null || data === undefined) return new Map<string, string>()
      if (!isRecord(data)) throw new Error('topics.yaml is not a mapping')
      return new Map(Object.entries(data).map(([name, entry]) => [name, triggerOf(entry)]))
    } catch (error) {
      log.warn('topics.yaml is malformed, treating it as empty', { error: String(error) })
      return new Map<string, string>()
    }
  }

  async function withTopic({ name, trigger }: { name: string; trigger: string }) {
    const raw = await readRaw(path)
    const parsed = parseDocument(raw)
    const document = parsed.errors.length > 0 || !parsed.contents ? new Document({}) : parsed
    document.set(name, { trigger })
    return document.toString({ lineWidth: 0 })
  }

  return { read, withTopic }
}
