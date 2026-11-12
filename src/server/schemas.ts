// Tool input schemas, shared by the MCP tools and the REST endpoints.
import * as z from 'zod'
import {
  BRANCH_MAX_CHARS,
  COMMIT_MAX_CHARS,
  MEMORY_MAX_CHARS,
  PROJECT_MAX_CHARS,
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  TOPIC_NAME_MAX_CHARS,
  TOPIC_NAME_PATTERN,
  TRIGGER_MAX_CHARS,
} from '../config.ts'

const MEMORY_ID_PATTERN = /^[mc]_[a-z0-9]{8}$/
const COMMIT_PATTERN = /^\S+$/
const QUERY_MAX_CHARS = 500
const HOST_MAX_CHARS = 100

const project = z
  .string()
  .min(1)
  .max(PROJECT_MAX_CHARS)
  .describe(
    'Project id: git origin as host/owner/repo (e.g. github.com/me/app), else the directory name',
  )
const branch = z.string().min(1).max(BRANCH_MAX_CHARS).describe('Git branch name')
const topic = z
  .string()
  .max(TOPIC_NAME_MAX_CHARS)
  .regex(TOPIC_NAME_PATTERN, 'topic must be lowercase kebab-case, e.g. "svelte" or "home-server"')

export const briefShape = {
  project: project.optional(),
  branch: branch.optional(),
}

export const recallShape = {
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_CHARS)
    .optional()
    .describe('Words or a question to search for'),
  topic: topic.optional().describe('List memories in this topic'),
  project: project.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RECALL_MAX_LIMIT)
    .optional()
    .describe(`Max results, default ${RECALL_DEFAULT_LIMIT}`),
}

export const rememberShape = {
  text: z
    .string()
    .min(1)
    .max(MEMORY_MAX_CHARS, `text is over ${MEMORY_MAX_CHARS} characters; save one fact per call`)
    .describe('The fact, 1-5 self-contained sentences'),
  topic: topic.describe('Existing topic name, or a new one together with topic_trigger'),
  scope: z
    .enum(['global', 'project', 'host'])
    .optional()
    .describe('global (default), project (needs project), host (needs host)'),
  project: project.optional(),
  host: z.string().min(1).max(HOST_MAX_CHARS).optional().describe('Machine name, for scope host'),
  // biome-ignore lint/style/useNamingConvention: tool argument name fixed by docs/design.md
  topic_trigger: z
    .string()
    .min(1)
    .max(TRIGGER_MAX_CHARS)
    .optional()
    .describe('Only for a new topic: one line, "read before ..."'),
  replaces: z
    .string()
    .regex(MEMORY_ID_PATTERN)
    .optional()
    .describe('Id of a memory to rewrite in place with this text'),
}

export const forgetShape = {
  id: z.string().regex(MEMORY_ID_PATTERN, 'id looks like m_xxxxxxxx or c_xxxxxxxx'),
}

export const checkpointShape = {
  project: project,
  branch: branch,
  commit: z
    .string()
    .min(1)
    .max(COMMIT_MAX_CHARS)
    .regex(COMMIT_PATTERN, 'commit must be a single hash')
    .describe('Current HEAD commit hash'),
  summary: z
    .string()
    .max(MEMORY_MAX_CHARS)
    .optional()
    .describe('What is done, what is next, what blocks. Omit to keep the stored summary'),
  done: z.boolean().optional().describe('true deletes the checkpoint (branch merged or abandoned)'),
}

export const briefSchema = z.object(briefShape)
export const checkpointSchema = z.object(checkpointShape)

export type BriefArgs = z.infer<typeof briefSchema>
export type RecallArgs = z.infer<z.ZodObject<typeof recallShape>>
export type RememberArgs = z.infer<z.ZodObject<typeof rememberShape>>
export type ForgetArgs = z.infer<z.ZodObject<typeof forgetShape>>
export type CheckpointArgs = z.infer<typeof checkpointSchema>
