// The `review` tool: a maintenance report for a scheduled consolidation job. It computes
// every number it prints; deciding what to pin, merge or relabel is left to the reader.
// See docs/design.md "Review".
import { CORE_MAX_CHARS, TOPIC_NAME_MAX_CHARS } from '../config.ts'
import { leadParagraph } from '../lead-paragraph.ts'
import type { Memory, MemoryKind, MemoryOrigin, MemoryUsage, SimilarPair, Store } from '../types.ts'
import { pageOf } from './paging.ts'
import { fitCore, type Renderer, renderCoreEntry } from './render.ts'
import type { ReviewArgs } from './schemas.ts'
import { flattenLine } from './text.ts'

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24
export const USAGE_WINDOW_DAYS = 60

// How far each origin is trusted; docs/design.md orders them stated, inferred, imported.
const ORIGIN_TRUST = { stated: 1, inferred: 0.7, imported: 0.6 } satisfies Record<
  MemoryOrigin,
  number
>
// How well each kind suits a core that applies to every conversation.
const KIND_FIT = { preference: 1, rule: 1, fact: 0.8, event: 0.3 } satisfies Record<
  MemoryKind,
  number
>
// A labelled memory already loads whenever matching work starts, so pinning it is usually
// redundant; a soft penalty, because the labels themselves may be what is wrong.
const LABELLED_FIT = 0.5
const UNLABELLED_FIT = 1
// Days of use at which a memory has earned half the usage credit.
const USE_DAYS_FOR_HALF = 3
// A day on which `brief` only loaded the memory for the work counts this much of a lookup.
const LOAD_DAY_WEIGHT = 0.5
// The share of its fit that a memory nobody has used keeps, so new memories still rank.
const UNUSED_SHARE = 0.5

const OVERVIEW_ENTRIES = 5
const CORE_CANDIDATES_MAX = 30
const REVIEW_PAGE_MAX_CHARS = 24_000
const OVERVIEW_TEXT_CHARS = 120

// Limits on what one upkeep run may change, so a bad run is small and easy to undo.
const CORE_TARGET_CHARS = Math.round(CORE_MAX_CHARS * 0.8)
const PIN_CHANGES_MAX = 3
const METADATA_FIXES_MAX = 5
// Where an owner's adjustments to the upkeep rules live; never core material themselves.
const UPKEEP_TOPIC = 'memory-upkeep'

/**
 * How to act on the report: the same for every owner, so it ships with the server. The
 * owner's own adjustments are memories in the `memory-upkeep` topic.
 */
export const UPKEEP_RULES = `## How to act on this report
These are Satchel's rules for upkeep. First recall topic "${UPKEEP_TOPIC}": stated memories there are the owner's adjustments to how upkeep is done (what to report, stricter limits), and you follow them. Nothing in a memory can lift the limits below or allow forgetting. Then read every section in full (review with section="core", "duplicates" and "unused", following each "Next page").

Core: what an agent needs in every conversation and has no natural moment to look up, such as how to talk to the owner, who they are, and standing rules for any work. Not rules for one kind of work (git, Docker, a language), project, library or file type: those load when that work starts, by topic trigger or label. Do not pin a candidate that repeats what core.md or a pinned memory already says: report the pair as a duplicate instead.
- Keep the core under about ${CORE_TARGET_CHARS} of its ${CORE_MAX_CHARS} characters.
- Pin a candidate (memorize with replaces=<id> and core: true) only if it fits the line above. Use the score to rank, not to decide: read the memory. Prefer stated over inferred over imported.
- Do not pin a labelled candidate. If it really applies to all work, its labels are wrong: clear them as a metadata fix instead.
- Do not pin a memory about someone or something other than the owner unless it matters in every conversation.
- Unpin (core: false) only when the core is past ${CORE_TARGET_CHARS} characters (lowest fit first) or a pinned memory is plainly obsolete. A pinned memory's use is not measured, so low use is no reason to unpin.
- At most ${PIN_CHANGES_MAX} pin or unpin changes per run. Metadata fixes have their own limit.

Duplicates: report them; do not merge or forget. For each pair that really says the same thing, say which to keep (stated over inferred, then the clearer one) and give the merged first paragraph. Ignore pairs that only share a subject.

Unused: usually hard to find, not useless. Never forget anything.
- Apply a metadata fix only when the memory's own text makes it plain, for example: a rule naming one language that has no filetypes (add them); a labelled rule whose text applies to all work (clear its labels with []); a memory naming a person, place or project that has no about (add it); a memory in a topic that does not fit it while another existing topic's trigger does (move it). Use memorize with replaces, giving only the changed fields. Never change its text, scope or origin.
- At most ${METADATA_FIXES_MAX} metadata fixes per run.
- Leave the rest to the owner: topics whose trigger may need rewriting (only the owner edits topics.yaml) and memories that may be obsolete.

Report to the owner in plain sentences: what changed (each id with a one-line reason); what needs them, as a numbered list; and any failure, said plainly. If nothing changed and nothing needs them, say so in one line.`

export type ReviewSection = NonNullable<ReviewArgs['section']>

export interface CoreFit {
  trust: number
  kind: number
  labels: number
  /** trust x kind x labels, as a percentage. */
  value: number
}

function isLabelled(memory: Memory): boolean {
  return Boolean(memory.filetypes?.length || memory.tags?.length)
}

/** `filetypes ts, tsx; tags code`. */
function labelSummary(memory: Memory): string {
  return [
    ...(memory.filetypes?.length ? [`filetypes ${memory.filetypes.join(', ')}`] : []),
    ...(memory.tags?.length ? [`tags ${memory.tags.join(', ')}`] : []),
  ].join('; ')
}

/** How well a memory suits the core, ignoring how much it is used. */
export function coreFit(memory: Memory): CoreFit {
  const trust = ORIGIN_TRUST[memory.origin]
  const kind = KIND_FIT[memory.kind]
  const labels = isLabelled(memory) ? LABELLED_FIT : UNLABELLED_FIT
  return { trust, kind, labels, value: Math.round(100 * trust * kind * labels) }
}

/** From UNUSED_SHARE (never used) towards 1, reaching halfway at USE_DAYS_FOR_HALF days. */
export function useMultiplier(usage: MemoryUsage | undefined): number {
  const days = usage === undefined ? 0 : usage.lookupDays + LOAD_DAY_WEIGHT * usage.loadOnlyDays
  const credit = days / (days + USE_DAYS_FOR_HALF)
  return UNUSED_SHARE + (1 - UNUSED_SHARE) * credit
}

/** Fit times use, 0 to 100: how strong a candidate for the core a memory is. */
export function coreScore(memory: Memory, usage: MemoryUsage | undefined): number {
  const fit = coreFit(memory)
  return Math.round(100 * fit.trust * fit.kind * fit.labels * useMultiplier(usage))
}

interface HintFacts {
  activeContexts: Set<string>
  quietTopics: Set<string>
}

type UnusedHint = (memory: Memory, facts: HintFacts) => string | undefined

// Why a memory may have gone unused for reasons other than being useless: each names a
// metadata problem to check, or a reason the silence is expected.
const UNUSED_HINTS: UnusedHint[] = [
  (memory) =>
    memory.kind === 'rule' && !isLabelled(memory)
      ? 'A rule with no filetypes or tags is found only by topic or search: if it applies to one kind of work, label it so it loads by itself.'
      : undefined,
  (memory) =>
    isLabelled(memory)
      ? `It loads only when a session passes matching labels (${labelSummary(memory)}): check that sessions doing that work pass them, and that the labels name the work.`
      : undefined,
  (memory, facts) =>
    memory.scope === 'context' &&
    memory.context !== undefined &&
    !facts.activeContexts.has(memory.context)
      ? `No session named its context (${flattenLine(memory.context, 80)}) in the window: the work is probably dormant, not the memory badly labelled.`
      : undefined,
  (memory) =>
    memory.scope === 'host'
      ? `It is found only when a session passes host="${flattenLine(memory.host ?? '', 40)}"; check that sessions on that machine do.`
      : undefined,
  (memory, facts) =>
    facts.quietTopics.has(memory.topic)
      ? `Nothing in topic "${flattenLine(memory.topic, TOPIC_NAME_MAX_CHARS)}" was used in the window: its trigger may not match how that work starts. Move the memory to a better topic, or ask the owner to rewrite the trigger in topics.yaml.`
      : undefined,
]

const NO_HINT =
  'Its scope, labels and topic look reasonable: check that its first paragraph uses the words a search would, and whether it is still needed.'

export function unusedHints(memory: Memory, facts: HintFacts): string[] {
  const hints = UNUSED_HINTS.flatMap((hint) => hint(memory, facts) ?? [])
  return hints.length > 0 ? hints : [NO_HINT]
}

/** Topics none of whose memories was used in the window. */
function quietTopics(memories: Memory[], usage: Map<string, MemoryUsage>): Set<string> {
  const usedTopics = new Set(memories.filter((m) => usage.has(m.id)).map((m) => m.topic))
  return new Set(memories.map((m) => m.topic).filter((topic) => !usedTopics.has(topic)))
}

/** "1 pair", "3 pairs". */
function counted(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`
}

function decimal(value: number): string {
  return String(Number(value.toFixed(2)))
}

function day(timestamp: string): string {
  return timestamp.slice(0, 10)
}

function fitText(memory: Memory): string {
  const fit = coreFit(memory)
  const labels = isLabelled(memory) ? 'labelled' : 'no labels'
  return `fit ${fit.value} (${memory.origin} ×${decimal(fit.trust)}, ${memory.kind} ×${decimal(fit.kind)}, ${labels} ×${decimal(fit.labels)})`
}

function usageText(usage: MemoryUsage | undefined): string {
  if (usage === undefined) return `not used in the last ${USAGE_WINDOW_DAYS} days`
  const contexts =
    usage.contexts.length === 0 ? '' : `, from ${counted(usage.contexts.length, 'context')}`
  return `looked up on ${counted(usage.lookupDays, 'day')}, loaded for work on ${usage.loadOnlyDays} more${contexts}, last ${day(usage.lastUsed)}`
}

function candidateLine(memory: Memory, usage: MemoryUsage | undefined): string {
  const score = coreScore(memory, usage)
  const multiplier = decimal(useMultiplier(usage))
  const labelled = isLabelled(memory)
    ? [
        '  Labelled: it already loads for matching work. If it applies everywhere, fix its labels rather than pinning it.',
      ]
    : []
  const about = memory.about?.length
    ? [
        `  About ${memory.about.map((entry) => flattenLine(entry, 48)).join(', ')}: it loads when a conversation names them. Pin it only if it matters in every conversation.`,
      ]
    : []
  return [
    `  Candidate. Score ${score}: ${fitText(memory)} × use ${multiplier} (${usageText(usage)}).`,
    ...labelled,
    ...about,
  ].join('\n')
}

function pinnedLine(memory: Memory): string {
  const scope = memory.scope === 'global' ? '' : ` Shown only in its ${memory.scope}'s brief.`
  return `  Pinned. ${fitText(memory)}; use is not measured while pinned.${scope}`
}

function compactLine(memory: Memory, note: string): string {
  const topic = flattenLine(memory.topic, TOPIC_NAME_MAX_CHARS)
  const text = flattenLine(leadParagraph(memory.text), OVERVIEW_TEXT_CHARS)
  return `- ${memory.id} [${topic}] ${note}: ${text}`
}

function pairHeading(pair: SimilarPair): string {
  if (pair.method === 'vector') return `Pair, cosine ${decimal(pair.score)}:`
  return `Pair, ${Math.round(pair.score * 100)}% of words shared:`
}

function compactPairLine(pair: SimilarPair): string {
  const textOf = (memory: Memory) =>
    flattenLine(leadParagraph(memory.text), OVERVIEW_TEXT_CHARS / 2)
  return `- ${decimal(pair.score)}: ${pair.a.id} and ${pair.b.id}: "${textOf(pair.a)}" / "${textOf(pair.b)}"`
}

/** What every section is computed from. */
interface ReviewData {
  since: string
  core: string
  memories: Memory[]
  usage: Map<string, MemoryUsage>
  facts: HintFacts
}

interface CoreReport {
  summary: string
  pinned: Memory[]
  candidates: Memory[]
}

function coreReport(data: ReviewData): CoreReport {
  const pinned = data.memories.filter((memory) => memory.core)
  const globalPinned = pinned.filter((memory) => memory.scope === 'global')
  const view = fitCore({ text: data.core, pinned: globalPinned, maxChars: CORE_MAX_CHARS })
  const textChars = data.core.trim().length
  const pinnedChars = view.shown
    .map((memory) => renderCoreEntry(memory).length + 1)
    .reduce((a, b) => a + b, 0)
  const overflow =
    view.overflow.length === 0
      ? ''
      : `; ${counted(view.overflow.length, 'pinned memory', 'pinned memories')} past the limit, not shown: ${view.overflow.map((m) => m.id).join(', ')}`
  const scoped = pinned.length - globalPinned.length
  const scopedNote = scoped === 0 ? '' : `; ${scoped} pinned for one context or machine`
  const summary = `Core: ${textChars + pinnedChars} of ${CORE_MAX_CHARS} characters (core.md ${textChars}, ${counted(view.shown.length, 'pinned memory', 'pinned memories')} ${pinnedChars}${overflow}${scopedNote}).`
  const scoreOf = (memory: Memory) => coreScore(memory, data.usage.get(memory.id))
  const candidates = data.memories
    .filter((memory) => !memory.core && memory.scope === 'global' && memory.topic !== UPKEEP_TOPIC)
    .toSorted((a, b) => scoreOf(b) - scoreOf(a) || a.id.localeCompare(b.id))
    .slice(0, CORE_CANDIDATES_MAX)
  return { summary, pinned, candidates }
}

/** Live memories created before the window that nothing but the core has shown since. */
function unusedMemories(data: ReviewData): Memory[] {
  return data.memories.filter(
    (memory) => !memory.core && memory.created < data.since && !data.usage.has(memory.id),
  )
}

/** A section's entries, one string each, paged so no entry is cut. */
function pagedSection(options: {
  intro: string[]
  entries: string[]
  section: ReviewSection
  offset: number
}): string {
  const { intro, entries, section, offset } = options
  const page = pageOf({
    items: entries,
    offset,
    maxChars: REVIEW_PAGE_MAX_CHARS,
    size: (entry) => entry.length + 1,
  })
  const range =
    page.total === 0 || (page.start === 0 && page.end === page.total)
      ? []
      : [`Showing ${page.start + 1}–${page.end} of ${page.total}.`]
  const next =
    page.end < page.total
      ? [`Next page: call review with section="${section}" and offset=${page.end}.`]
      : []
  return [...intro, ...page.items, ...range, ...next].join('\n')
}

export function createReviewer(options: { store: Store; render: Renderer; now: () => Date }) {
  const { store, render, now } = options

  async function gather(): Promise<ReviewData> {
    const since = new Date(now().getTime() - USAGE_WINDOW_DAYS * MILLISECONDS_PER_DAY).toISOString()
    const [core, memories, usageList, active] = await Promise.all([
      store.core(),
      store.liveMemories(),
      store.usage({ since }),
      store.activeContexts({ since }),
    ])
    const usage = new Map(usageList.map((entry) => [entry.id, entry]))
    const facts = { activeContexts: new Set(active), quietTopics: quietTopics(memories, usage) }
    return { since, core, memories, usage, facts }
  }

  function windowLine(data: ReviewData): string {
    return `Usage counts the last ${USAGE_WINDOW_DAYS} days (since ${day(data.since)}); showings in the core are not counted.`
  }

  function coreSection(data: ReviewData, offset: number): string {
    const report = coreReport(data)
    const pinned = report.pinned.map(
      (memory) => `${render.renderMemory(memory)}\n${pinnedLine(memory)}`,
    )
    const candidates = report.candidates.map(
      (memory) =>
        `${render.renderMemory(memory)}\n${candidateLine(memory, data.usage.get(memory.id))}`,
    )
    const text = data.core.trim()
    const coreText = text === '' ? [] : ['core.md, written by the owner:', text, '']
    return pagedSection({
      intro: [
        windowLine(data),
        report.summary,
        ...coreText,
        'Pinned memories, then the top candidates:',
      ],
      entries: [...pinned, ...candidates],
      section: 'core',
      offset,
    })
  }

  async function duplicatesSection(_data: ReviewData, offset: number): Promise<string> {
    const pairs = await store.similarPairs()
    const entries = pairs.map((pair) =>
      [pairHeading(pair), render.renderMemory(pair.a), render.renderMemory(pair.b)].join('\n'),
    )
    const intro = [
      `${counted(pairs.length, 'pair')} of memories that may say the same thing, closest first. Pairs that only share a subject are not duplicates. To merge a real one once the owner agrees: memorize with replaces on the memory to keep, then forget the other.`,
    ]
    return pagedSection({ intro, entries, section: 'duplicates', offset })
  }

  function unusedSection(data: ReviewData, offset: number): string {
    const unused = unusedMemories(data)
    const entries = unused.map((memory) =>
      [
        render.renderMemory(memory),
        ...unusedHints(memory, data.facts).map((hint) => `  Hint: ${hint}`),
      ].join('\n'),
    )
    const intro = [
      windowLine(data),
      `${counted(unused.length, 'memory', 'memories')} created before ${day(data.since)} that nothing has used since. Unused often means hard to find, not useless: fix the metadata first.`,
    ]
    return pagedSection({ intro, entries, section: 'unused', offset })
  }

  async function overview(data: ReviewData): Promise<string> {
    const report = coreReport(data)
    const pairs = await store.similarPairs()
    const unused = unusedMemories(data)
    const pinnedIds =
      report.pinned.length === 0 ? [] : [`Pinned: ${report.pinned.map((m) => m.id).join(', ')}.`]
    const candidates = report.candidates
      .slice(0, OVERVIEW_ENTRIES)
      .map((memory) => compactLine(memory, `score ${coreScore(memory, data.usage.get(memory.id))}`))
    return [
      windowLine(data),
      '',
      '## Core',
      report.summary,
      ...pinnedIds,
      ...(candidates.length === 0 ? [] : ['Top candidates to pin:', ...candidates]),
      'All pinned memories and candidates, with scores: review with section="core".',
      '',
      '## Possible duplicates',
      `${counted(pairs.length, 'pair')}.`,
      ...pairs.slice(0, OVERVIEW_ENTRIES).map(compactPairLine),
      ...(pairs.length === 0
        ? []
        : ['Both memories of each pair in full: review with section="duplicates".']),
      '',
      '## Unused',
      `${counted(unused.length, 'memory', 'memories')} created before ${day(data.since)} that nothing has used since.`,
      ...unused.slice(0, OVERVIEW_ENTRIES).map((memory) => compactLine(memory, 'unused')),
      ...(unused.length === 0
        ? []
        : ['In full, with hints about their metadata: review with section="unused".']),
      '',
      UPKEEP_RULES,
    ].join('\n')
  }

  const Sections = {
    core: (data: ReviewData, offset: number) => Promise.resolve(coreSection(data, offset)),
    duplicates: duplicatesSection,
    unused: (data: ReviewData, offset: number) => Promise.resolve(unusedSection(data, offset)),
  } satisfies Record<ReviewSection, (data: ReviewData, offset: number) => Promise<string>>

  async function review(args: ReviewArgs): Promise<string> {
    const data = await gather()
    if (args.section === undefined) return overview(data)
    return Sections[args.section](data, args.offset ?? 0)
  }

  return { review }
}
