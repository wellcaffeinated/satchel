// Input schemas of the MCP tools.
import * as z from 'zod'
import {
  ABOUT_MAX_CHARS,
  ABOUT_PATTERN,
  CHECKPOINT_SUMMARY_MAX_CHARS,
  COMMIT_MAX_CHARS,
  CONTEXT_MAX_CHARS,
  FILETYPE_PATTERN,
  HOST_MAX_CHARS,
  LABEL_MAX_CHARS,
  LABELS_MAX_COUNT,
  MEMORY_KINDS,
  MEMORY_MAX_CHARS,
  MEMORY_ORIGINS,
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  REFERENCE_DESCRIPTION_MAX_CHARS,
  REFERENCE_FORMAT_PATTERN,
  REFERENCE_MAX_CHARS,
  REFERENCE_TITLE_MAX_CHARS,
  REQUEST_LABELS_MAX_COUNT,
  TAG_PATTERN,
  THREAD_MAX_CHARS,
  TOPIC_NAME_MAX_CHARS,
  TOPIC_NAME_PATTERN,
  TRIGGER_MAX_CHARS,
} from '../config.ts'

const MEMORY_ID_PATTERN = /^[mcr]_[a-z0-9]{8}$/
const MEMORY_OR_REFERENCE_ID_PATTERN = /^[mr]_[a-z0-9]{8}$/
const COMMIT_PATTERN = /^\S+$/
const QUERY_MAX_CHARS = 500
const TIME_MAX_CHARS = 40

const context = z
  .string()
  .min(1)
  .max(CONTEXT_MAX_CHARS)
  .describe(
    'What the work belongs to: in a git repo the project id (origin as host/owner/repo, e.g. github.com/me/app, else the directory name); otherwise a short name for the undertaking, e.g. "grant-proposal"',
  )
const thread = z
  .string()
  .min(1)
  .max(THREAD_MAX_CHARS)
  .describe('One line of work in the context: the git branch, or "main" when there is only one')
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
const aboutLabel = z
  .array(
    z
      .string()
      .min(1)
      .max(ABOUT_MAX_CHARS)
      .regex(
        ABOUT_PATTERN,
        'about values are lowercase kebab-case, optionally typed: "alice", "person:alice"',
      ),
  )
  .max(LABELS_MAX_COUNT)
  .describe(
    'Who or what this concerns: entities as "name" or "kind:name", e.g. ["person:alice", "place:lisbon"]. Not for subjects a topic or tag already covers',
  )
// A day or an ISO 8601 timestamp; null clears the field on an update.
const time = z.string().min(1).max(TIME_MAX_CHARS).nullable()
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
const workAbout = z
  .array(
    z
      .string()
      .min(1)
      .max(ABOUT_MAX_CHARS * 2),
  )
  .max(REQUEST_LABELS_MAX_COUNT)
  .describe('Entities to find memories about, e.g. ["person:alice"]; any match counts')
const thisHost = z
  .string()
  .min(1)
  .max(HOST_MAX_CHARS)
  .describe("This machine's name (short hostname), if you know it")
const topic = z
  .string()
  .max(TOPIC_NAME_MAX_CHARS)
  .regex(TOPIC_NAME_PATTERN, 'topic must be lowercase kebab-case, e.g. "svelte" or "home-server"')
const kind = z.enum(MEMORY_KINDS)

export const briefShape = {
  context: context.optional(),
  thread: thread.optional(),
  host: thisHost.optional(),
  filetypes: workFiletypes.optional(),
  tags: workTags.optional(),
  about: workAbout
    .optional()
    .describe(
      'People, places or things this conversation concerns, e.g. ["person:alice"]: what is known about them is loaded in full',
    ),
}

export const recallShape = {
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_CHARS)
    .optional()
    .describe('Words or a question to search for'),
  topic: topic.optional().describe('List memories in this topic'),
  context: context
    .optional()
    .describe("Your context: its memories rank first, other contexts' are left out"),
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
  about: workAbout.optional(),
  kind: kind.optional().describe('Keep only memories of this kind'),
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
    .optional()
    .describe(
      'First paragraph: the rule or fact, 1-5 self-contained sentences. Examples (e.g. a BAD/GOOD code block) may follow after a blank line. Required unless replaces is given',
    ),
  topic: topic
    .optional()
    .describe(
      'Existing topic name, or a new one together with topic_trigger. Required unless replaces is given',
    ),
  kind: kind
    .optional()
    .describe(
      'rule: how to do something. fact (default): true of the world or the user. event: something that happened or will happen, with date. preference: what the user likes or wants',
    ),
  origin: z
    .enum(MEMORY_ORIGINS)
    .optional()
    .describe(
      'stated: the user said it in so many words. inferred (default): you concluded it. imported: copied from another system',
    ),
  date: time.optional().describe('For an event: the day it happens, YYYY-MM-DD'),
  expires: time
    .optional()
    .describe(
      'When this stops applying: a day YYYY-MM-DD (it still applies that whole day) or a timestamp; after that it is hidden and later deleted',
    ),
  about: aboutLabel.optional(),
  scope: z
    .enum(['global', 'context', 'host'])
    .optional()
    .describe(
      'global (default): anything not tied to one context or machine, including preferences. context: only true of that repository or undertaking (needs context). host: only true of that machine, e.g. its setup or paths (needs host)',
    ),
  context: context.optional().describe('The context, used only with scope context'),
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
    .describe(
      'Id of a memory to update in place. Fields left out keep their stored values; [] clears a list, null clears date or expires',
    ),
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
  title: z
    .string()
    .min(1)
    .max(REFERENCE_TITLE_MAX_CHARS)
    .optional()
    .describe('What this is, in a few words. Required unless replaces is given'),
  description: z
    .string()
    .min(1)
    .max(REFERENCE_DESCRIPTION_MAX_CHARS)
    .optional()
    .describe(
      'One line: what it is for and when to use it; this is what search matches. Required unless replaces is given',
    ),
  content: z
    .string()
    .min(1)
    .max(REFERENCE_MAX_CHARS)
    .optional()
    .describe('The material, verbatim. Required unless replaces is given'),
  format: z
    .string()
    .regex(REFERENCE_FORMAT_PATTERN)
    .optional()
    .describe('Language of the content, e.g. "jsonc", "yaml", "sh"; default "markdown"'),
  topic: memorizeShape.topic,
  scope: memorizeShape.scope,
  context: memorizeShape.context,
  host: memorizeShape.host,
  filetypes: memorizeShape.filetypes,
  tags: memorizeShape.tags,
  about: aboutLabel.optional(),
  expires: memorizeShape.expires,
  // biome-ignore lint/style/useNamingConvention: tool argument name fixed by docs/design.md
  topic_trigger: memorizeShape.topic_trigger,
  replaces: z
    .string()
    .regex(/^r_[a-z0-9]{8}$/)
    .optional()
    .describe('Id of a reference to update in place. Fields left out keep their stored values'),
}

export const checkpointShape = {
  // Optional in the schema so a call without it gets the service's message, which says what
  // to pass, instead of the validator's "expected string at context".
  context: context.optional(),
  thread: thread.optional().describe('Defaults to "main"'),
  commit: z
    .string()
    .min(1)
    .max(COMMIT_MAX_CHARS)
    .regex(COMMIT_PATTERN, 'commit must be a single hash')
    .optional()
    .describe('Current HEAD commit hash, for a code thread. Omit to keep the stored one'),
  summary: z
    .string()
    .max(CHECKPOINT_SUMMARY_MAX_CHARS)
    .optional()
    .describe('What is done, what is next, what blocks. Omit to keep the stored summary'),
  done: z
    .boolean()
    .optional()
    .describe('true deletes the checkpoint (thread merged, finished or abandoned)'),
}

export const briefSchema = z.object(briefShape)
export const recallSchema = z.object(recallShape)
export const memorizeSchema = z.object(memorizeShape)
export const forgetSchema = z.object(forgetShape)
export const readSchema = z.object(readShape)
export const saveReferenceSchema = z.object(saveReferenceShape)
export const checkpointSchema = z.object(checkpointShape)

export type BriefArgs = z.infer<typeof briefSchema>
export type RecallArgs = z.infer<typeof recallSchema>
export type MemorizeArgs = z.infer<typeof memorizeSchema>
export type ForgetArgs = z.infer<typeof forgetSchema>
export type ReadArgs = z.infer<typeof readSchema>
export type SaveReferenceArgs = z.infer<typeof saveReferenceSchema>
export type CheckpointArgs = z.infer<typeof checkpointSchema>
