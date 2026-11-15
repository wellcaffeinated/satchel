// Input schemas of the MCP tools.
import * as z from 'zod'
import {
  BRANCH_MAX_CHARS,
  CHECKPOINT_SUMMARY_MAX_CHARS,
  COMMIT_MAX_CHARS,
  FILETYPE_PATTERN,
  HOST_MAX_CHARS,
  LABEL_MAX_CHARS,
  LABELS_MAX_COUNT,
  MEMORY_MAX_CHARS,
  PROJECT_MAX_CHARS,
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  REFERENCE_DESCRIPTION_MAX_CHARS,
  REFERENCE_FORMAT_PATTERN,
  REFERENCE_MAX_CHARS,
  REFERENCE_TITLE_MAX_CHARS,
  REQUEST_LABELS_MAX_COUNT,
  TAG_PATTERN,
  TOPIC_NAME_MAX_CHARS,
  TOPIC_NAME_PATTERN,
  TRIGGER_MAX_CHARS,
} from '../config.ts'

const MEMORY_ID_PATTERN = /^[mcr]_[a-z0-9]{8}$/
const MEMORY_OR_REFERENCE_ID_PATTERN = /^[mr]_[a-z0-9]{8}$/
const COMMIT_PATTERN = /^\S+$/
const QUERY_MAX_CHARS = 500

const project = z
  .string()
  .min(1)
  .max(PROJECT_MAX_CHARS)
  .describe(
    'Project id: git origin as host/owner/repo (e.g. github.com/me/app), else the directory name',
  )
const branch = z.string().min(1).max(BRANCH_MAX_CHARS).describe('Git branch name')
const filetypesLabel = z
  .array(
    z
      .string()
      .min(1)
      .max(LABEL_MAX_CHARS)
      .regex(FILETYPE_PATTERN, 'file types are extensions without the dot, e.g. "ts"'),
  )
  .max(LABELS_MAX_COUNT)
const tagsLabel = z
  .array(
    z
      .string()
      .min(1)
      .max(LABEL_MAX_CHARS)
      .regex(TAG_PATTERN, 'tags are lowercase kebab-case, e.g. "code" or "rxjs"'),
  )
  .max(LABELS_MAX_COUNT)
// What the caller is working on. Lenient: values are normalised and odd ones dropped.
const workFiletypes = z
  .array(
    z
      .string()
      .min(1)
      .max(LABEL_MAX_CHARS * 2),
  )
  .max(REQUEST_LABELS_MAX_COUNT)
  .describe('File types you are working on: extensions, e.g. ["ts", "svelte"]')
const workTags = z
  .array(
    z
      .string()
      .min(1)
      .max(LABEL_MAX_CHARS * 2),
  )
  .max(REQUEST_LABELS_MAX_COUNT)
  .describe('What the work involves: ["code"] when writing code, plus libraries such as "rxjs"')
const thisHost = z
  .string()
  .min(1)
  .max(HOST_MAX_CHARS)
  .describe("This machine's name (short hostname), if you know it")
const topic = z
  .string()
  .max(TOPIC_NAME_MAX_CHARS)
  .regex(TOPIC_NAME_PATTERN, 'topic must be lowercase kebab-case, e.g. "svelte" or "home-server"')

export const briefShape = {
  project: project.optional(),
  branch: branch.optional(),
  host: thisHost.optional(),
  filetypes: workFiletypes.optional(),
  tags: workTags.optional(),
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
  host: thisHost
    .optional()
    .describe(
      "This machine's name: its memories rank first, other machines' are left out. Alone, lists what is known about that machine",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RECALL_MAX_LIMIT)
    .optional()
    .describe(`Max memories per page; searches default to ${RECALL_DEFAULT_LIMIT}`),
  filetypes: workFiletypes.optional(),
  tags: workTags.optional(),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Where the page starts; use the value a previous page ended with'),
}

export const memorizeShape = {
  text: z
    .string()
    .min(1)
    .max(MEMORY_MAX_CHARS, `text is over ${MEMORY_MAX_CHARS} characters; save one rule per call`)
    .describe(
      'First paragraph: the rule or fact, 1-5 self-contained sentences. Examples (e.g. a BAD/GOOD code block) may follow after a blank line',
    ),
  topic: topic.describe('Existing topic name, or a new one together with topic_trigger'),
  scope: z
    .enum(['global', 'project', 'host'])
    .optional()
    .describe(
      'global (default): anything not tied to one repo or machine, including preferences. project: only true of that repository (needs project). host: only true of that machine, e.g. its setup or paths (needs host)',
    ),
  project: project.optional(),
  host: z
    .string()
    .min(1)
    .max(HOST_MAX_CHARS)
    .optional()
    .describe('Machine name, used only with scope host. Not just where you are running'),
  filetypes: filetypesLabel
    .optional()
    .describe('Only if the rule applies only to these file types: extensions, e.g. ["ts", "tsx"]'),
  tags: tagsLabel
    .optional()
    .describe(
      'Only if the rule applies only to this kind of work: ["code"] for any code, a library name such as ["rxjs"], an activity such as ["testing"]',
    ),
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
  id: z.string().regex(MEMORY_ID_PATTERN, 'id looks like m_xxxxxxxx, r_xxxxxxxx or c_xxxxxxxx'),
}

export const readShape = {
  id: z
    .string()
    .regex(MEMORY_OR_REFERENCE_ID_PATTERN, 'id looks like r_xxxxxxxx or m_xxxxxxxx')
    .describe('A reference (r_...) or memory (m_...) id'),
}

export const saveReferenceShape = {
  title: z.string().min(1).max(REFERENCE_TITLE_MAX_CHARS).describe('What this is, in a few words'),
  description: z
    .string()
    .min(1)
    .max(REFERENCE_DESCRIPTION_MAX_CHARS)
    .describe('One line: what it is for and when to use it; this is what search matches'),
  content: z.string().min(1).max(REFERENCE_MAX_CHARS).describe('The material, verbatim'),
  format: z
    .string()
    .regex(REFERENCE_FORMAT_PATTERN)
    .optional()
    .describe('Language of the content, e.g. "jsonc", "yaml", "sh"; default "markdown"'),
  topic: topic.describe('Existing topic name, or a new one together with topic_trigger'),
  scope: memorizeShape.scope,
  project: project.optional(),
  host: memorizeShape.host,
  filetypes: memorizeShape.filetypes,
  tags: memorizeShape.tags,
  // biome-ignore lint/style/useNamingConvention: tool argument name fixed by docs/design.md
  topic_trigger: memorizeShape.topic_trigger,
  replaces: z
    .string()
    .regex(/^r_[a-z0-9]{8}$/)
    .optional()
    .describe('Id of a reference to rewrite in place'),
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
    .max(CHECKPOINT_SUMMARY_MAX_CHARS)
    .optional()
    .describe('What is done, what is next, what blocks. Omit to keep the stored summary'),
  done: z.boolean().optional().describe('true deletes the checkpoint (branch merged or abandoned)'),
}

export const briefSchema = z.object(briefShape)
export const checkpointSchema = z.object(checkpointShape)

export type BriefArgs = z.infer<typeof briefSchema>
export type RecallArgs = z.infer<z.ZodObject<typeof recallShape>>
export type MemorizeArgs = z.infer<z.ZodObject<typeof memorizeShape>>
export type ForgetArgs = z.infer<z.ZodObject<typeof forgetShape>>
export type ReadArgs = z.infer<z.ZodObject<typeof readShape>>
export type SaveReferenceArgs = z.infer<z.ZodObject<typeof saveReferenceShape>>
export type CheckpointArgs = z.infer<typeof checkpointSchema>
