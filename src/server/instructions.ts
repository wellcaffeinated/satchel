// MCP `instructions`, generated per connection from the live topic list.
import { INSTRUCTIONS_MAX_CHARS } from '../config.ts'
import type { Topic } from '../types.ts'
import { renderTopicLine, USAGE_RULES } from './render.ts'

export const RULES = [
  'Satchel is your long-term memory, shared across sessions and agents.',
  '- Call `brief` once at the start of a conversation, with `project` and `branch` if known.',
  USAGE_RULES,
].join('\n')

const TOPICS_HEADER = 'Topics (name (memories): when to recall):'
const NO_TOPICS = 'Topics: none yet. Start one with `remember` and `topic_trigger`.'

export function moreTopicsLine(hidden: number): string {
  return `+${hidden} more topics; call \`brief\` for the full list.`
}

function byCountDescending(a: Topic, b: Topic): number {
  return b.count - a.count
}

/** Leading lines whose total length, each with its newline, stays within `budget`. */
function linesWithin(lines: string[], budget: number): string[] {
  const firstOver = lines.findIndex((_, index) => usedBy(lines.slice(0, index + 1)) > budget)
  return firstOver === -1 ? lines : lines.slice(0, firstOver)
}

function usedBy(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0)
}

export function renderInstructions(topics: Topic[], options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? INSTRUCTIONS_MAX_CHARS
  if (topics.length === 0) return `${RULES}\n\n${NO_TOPICS}`.slice(0, maxChars)

  const head = `${RULES}\n\n${TOPICS_HEADER}`
  const lines = topics.toSorted(byCountDescending).map(renderTopicLine)
  const all = linesWithin(lines, maxChars - head.length)
  if (all.length === lines.length) return [head, ...lines].join('\n')

  // Reserve room for the closing line sized for the largest possible hidden count.
  const reserve = moreTopicsLine(lines.length).length + 1
  const kept = linesWithin(lines, maxChars - head.length - reserve)
  return [head, ...kept, moreTopicsLine(lines.length - kept.length)].join('\n').slice(0, maxChars)
}
