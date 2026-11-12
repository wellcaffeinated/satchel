// Text rendering for tool results and REST responses: compact, written for a model to read.
import {
  BRANCH_MAX_CHARS,
  COMMIT_MAX_CHARS,
  PROJECT_MAX_CHARS,
  TOPIC_NAME_MAX_CHARS,
  TRIGGER_MAX_CHARS,
} from '../config.ts'
import type { Checkpoint, Memory, Topic } from '../types.ts'
import { flattenLine, indentContinuation, isoDate, isoMinute } from './text.ts'

const ENTRY_INDENT = '  '
const SOURCE_MAX_CHARS = 64

export interface BriefData {
  core: string
  topics: Topic[]
  project?: string
  branch?: string
  checkpoints: Checkpoint[]
  projectMemoryCount: number
}

function scopeLabel(memory: Memory): string {
  const scopeLabels: Record<Memory['scope'], () => string> = {
    global: () => 'global',
    project: () => `project ${flattenLine(memory.project ?? '?', PROJECT_MAX_CHARS)}`,
    host: () => `host ${flattenLine(memory.host ?? '?', PROJECT_MAX_CHARS)}`,
  }
  return (scopeLabels[memory.scope] ?? (() => flattenLine(String(memory.scope), 16)))()
}

/** `- m_x [topic | scope | date] text`, continuation lines indented. */
export function renderMemory(memory: Memory): string {
  const topic = flattenLine(memory.topic, TOPIC_NAME_MAX_CHARS)
  const header = `- ${flattenLine(memory.id, 16)} [${topic} | ${scopeLabel(memory)} | ${isoDate(memory.updated)}]`
  return `${header} ${indentContinuation(memory.text, ENTRY_INDENT)}`
}

export function renderMemories(memories: Memory[]): string {
  return memories.map(renderMemory).join('\n')
}

export function renderTopicLine(topic: Topic): string {
  const name = flattenLine(topic.name, TOPIC_NAME_MAX_CHARS)
  const trigger = flattenLine(topic.trigger, TRIGGER_MAX_CHARS)
  return `- ${name} (${topic.count}): ${trigger || '(no trigger)'}`
}

/** One line, so `checkpoint-commit: <hash>` stays greppable whatever was stored. */
export function checkpointCommit(checkpoint: Checkpoint): string {
  return flattenLine(checkpoint.commit, COMMIT_MAX_CHARS)
}

/**
 * A checkpoint is a claim about the past. `commitKey` is `checkpoint-commit` for the branch
 * the caller asked about (the plugin's session-start hook greps that line), else `commit`.
 */
export function renderCheckpoint(
  checkpoint: Checkpoint,
  options: { commitKey: 'checkpoint-commit' | 'commit' },
): string {
  const commit = checkpointCommit(checkpoint)
  const summary = indentContinuation(checkpoint.summary, ENTRY_INDENT)
  return [
    `Checkpoint ${flattenLine(checkpoint.id, 16)} (unverified claim)`,
    `project: ${flattenLine(checkpoint.project, PROJECT_MAX_CHARS)}`,
    `branch: ${flattenLine(checkpoint.branch, BRANCH_MAX_CHARS)}`,
    `${options.commitKey}: ${commit}`,
    `updated: ${isoMinute(checkpoint.updated)} by ${flattenLine(checkpoint.source, SOURCE_MAX_CHARS)}`,
    `summary: ${summary || '(none)'}`,
    `Verify before relying on it: compare commit ${commit} with the repo (git log, git status); the branch may have moved on.`,
  ].join('\n')
}

function renderCore(core: string): string {
  const trimmed = core.trim()
  return `## Core\n${trimmed || '(empty)'}`
}

function renderTopics(topics: Topic[]): string {
  if (topics.length === 0) {
    return '## Topics\nNone yet. Start one with `remember` and `topic_trigger`.'
  }
  const lines = topics.map(renderTopicLine).join('\n')
  return `## Topics (name (memories): when to recall)\n${lines}`
}

function renderCheckpointSection(data: BriefData, project: string): string {
  if (data.branch !== undefined) {
    const checkpoint = data.checkpoints[0]
    const branch = flattenLine(data.branch, BRANCH_MAX_CHARS)
    if (!checkpoint) return `No checkpoint for ${project} @ ${branch}.`
    return renderCheckpoint(checkpoint, { commitKey: 'checkpoint-commit' })
  }
  if (data.checkpoints.length === 0) return `No checkpoints for ${project}.`
  const render = (checkpoint: Checkpoint) => renderCheckpoint(checkpoint, { commitKey: 'commit' })
  return data.checkpoints.map(render).join('\n\n')
}

function renderProject(data: BriefData, rawProject: string): string {
  const project = flattenLine(rawProject, PROJECT_MAX_CHARS)
  return [
    `## Project ${project}`,
    `Project memories: ${data.projectMemoryCount} (recall with project="${project}").`,
    renderCheckpointSection(data, project),
  ].join('\n')
}

export function renderBrief(data: BriefData): string {
  const project = data.project === undefined ? [] : [renderProject(data, data.project)]
  return [renderCore(data.core), renderTopics(data.topics), ...project].join('\n\n')
}
