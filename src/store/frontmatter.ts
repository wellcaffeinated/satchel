import { Document, parse, visit } from 'yaml'

const FRONTMATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/

export interface FrontmatterDocument {
  data: Record<string, unknown>
  body: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Splits `---\nyaml\n---\nbody`. Throws an Error describing why a file is malformed. */
export function parseFrontmatter(raw: string): FrontmatterDocument {
  const normalised = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = FRONTMATTER.exec(normalised)
  if (!match) throw new Error('missing YAML frontmatter')
  const data: unknown = parse(match[1] ?? '')
  if (!isRecord(data)) throw new Error('frontmatter is not a mapping')
  return { data, body: (match[2] ?? '').trim() }
}

export function renderFrontmatter({ data, body }: FrontmatterDocument): string {
  const document = new Document(data)
  // Lists read better inline in a header: `tags: [code, rxjs]`.
  visit(document, {
    // biome-ignore lint/style/useNamingConvention: the visitor key is fixed by the yaml library
    Seq(_, node) {
      node.flow = true
    },
  })
  const yaml = document.toString({ lineWidth: 0 })
  return `---\n${yaml}---\n${body}\n`
}

/** A required non-empty string field, or an Error naming the field. */
export function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number') return String(value)
  throw new Error(`missing or invalid "${key}"`)
}

/** A list of strings, or undefined when absent or empty. Non-string items are an Error. */
export function optionalStringList(
  data: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = data[key]
  if (value === undefined || value === null) return undefined
  const items = Array.isArray(value) ? value : [value]
  const strings = items.map((item) => (typeof item === 'number' ? String(item) : item))
  if (!strings.every((item): item is string => typeof item === 'string')) {
    throw new Error(`"${key}" must be a list of strings`)
  }
  return strings.length === 0 ? undefined : strings
}

export function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

/** True only for a YAML `true`; anything else, absent included, is false. */
export function optionalFlag(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true
}
