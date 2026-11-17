# Satchel design

Satchel is a self-hosted memory service for AI agents. One server holds one person's
memories and serves them to any MCP client. This file is the contract the code is built
against; when code and this file disagree, fix one of them in the same change.

## Goals

- One store, reachable from every agent the owner uses (Claude Code, claude.ai, Claude
  Desktop and mobile, Hermes, anything else that speaks MCP).
- A small, fixed-size start-of-session load that tells an agent what it can look up.
- The rules that apply to the work at hand (writing TypeScript, using RxJS) reach the agent
  when that work starts, in full, without the agent having to think of asking.
- Agents decide when to save; the owner never has to review, but can browse and edit.
- Plain files as the source of truth. Everything else is a cache that can be rebuilt.
- Standard protocols only in the server: MCP over Streamable HTTP. Nothing in `src/` is
  specific to one client. Client-specific glue lives in `plugin/`.
- Runs as one Docker container with one mounted volume.

## What is stored

1. **Core**: standing facts and preferences that matter in every conversation, loaded by
   `brief`. Two parts share the cap `CORE_MAX_CHARS` (4,000): `core.md`, which only the
   owner edits, then the memories pinned with `core: true` (see "The core").
2. **Map**: one line per topic: name, trigger ("read before ..."), counts. Rendered from
   `topics.yaml` plus counts. Loaded in MCP `instructions` and by `brief`, followed by the
   tags and file types in use (with counts) and, in `brief`, the machines that have
   host-scoped memories.
3. **Memories**: one rule or fact per file. The first paragraph states it; examples, such
   as code blocks, may follow. Fetched through `recall`, or loaded by `brief` when their
   labels match the work (see "Loading by file type and tag"). Each has a `kind` and an
   `origin`, may carry a `date` and an `expires` time, and may say what it is `about`
   (see "Kind, origin, dates and about").
4. **References**: verbatim material an agent consults or copies (a `biome.json`, a
   template, a checklist), with a title and a one-line description. Never loaded
   automatically: `recall` lists them by title, `read` returns the content.

A **context** is anything work happens in: a repository (named by its project id, the
`origin` remote reduced to `host/owner/repo`, else the directory name) or an undertaking
with no code ("grant-proposal"). A **thread** is one line of work inside it: a git branch,
or `main` when there is only one. The same two words name where work happens everywhere:
in `brief`, in `recall`, in a memory's scope and in checkpoints.

A **checkpoint** records where work left off on one thread of one context. There is one checkpoint per `(context, thread)`, overwritten on each
update. The `commit` is optional: only code threads have one.

### Kind, origin, dates and about

Not everything worth remembering is a rule. A memory says what sort of thing it is, so a
reader can treat a standing rule, a dated event and a guess differently:

- `kind`: `rule` (how to do something; most carry labels), `fact` (something true of the
  world or the owner, the default), `event` (something that happened or will happen, with
  a `date`), `preference` (what the owner likes or wants, stated or observed).
- `origin`: `stated` (the owner said it, in so many words), `inferred` (the agent concluded
  it from what it saw; the default), `imported` (copied from another system or file). An
  agent says "you told me" only for `stated`. Consolidation (future) trusts them in that
  order.
- `date`: the day an `event` happened or will happen, `YYYY-MM-DD` or a full timestamp.
  Required for `kind: event`, allowed on any kind.
- `expires`: when the memory stops applying. A timestamp is the instant it ends; a day
  (`2026-11-30`) is inclusive, so the memory applies until that day ends in
  `SATCHEL_TIMEZONE` ("valid until Nov 30" means through Nov 30). The day is compared at
  query time, so changing the zone needs no reindex. Expired memories
  are hidden from `recall`, `brief`, the similar-memory check and every count as soon as
  the time passes, and deleted (one git commit per sweep) when the server starts and once
  a day after that; `read` returns one by id until then.
- `about`: what the memory concerns: entities, each `name` or `kind:name` in lowercase
  kebab-case (`alice`, `person:alice`, `place:lisbon`, `project:garden-shed`). Up to 10,
  each at most 48 characters. `recall` with `about` returns memories sharing any of them.
  `about` is separate from `tags` because tags drive automatic loading and are listed in
  the instructions; `about` only filters and is listed in the brief.

### Labels: `filetypes` and `tags`

Memories and references may carry two optional label lists:

- `filetypes`: file extensions without the dot, lowercase (`ts`, `svelte`, `py`). The rule
  applies only when working on files of those types.
- `tags`: lowercase kebab-case labels for what a file type cannot express. Libraries and
  frameworks use their package name (`rxjs`, `svelte`); `code` marks rules about code in
  any language; activities get their own (`testing`, `review`). There are no reserved
  values: `code` is a convention between clients and memories, not a server feature.

**Matching**: a request carries `filetypes` and/or `tags`. A memory matches when it has at
least one label and **every label field it sets** shares a value with the request. A
memory with `tags: [code]` matches any request whose tags include `code`. A memory with
`filetypes: [ts, js]` and `tags: [rxjs]` matches only a request with `ts` or `js` among its
file types and `rxjs` among its tags. A memory with no labels never matches; it is found by
topic or search.

Labels are opt-in, like `host`: an agent sets them only when a rule really is limited to
those files or that library. Up to 10 values per field, each at most 32 characters.

## Data directory

The memories live under `SATCHEL_DATA` (default `./data`, `/data` in the container), and
nothing else does: a backup of this directory is a backup of everything worth keeping.

```
$SATCHEL_DATA/
  repo/                       git repository, the source of truth
    core.md
    topics.yaml               { <topic>: { trigger: "<one line>" } }
    memories/<topic>/<slug>-<id>.md
    references/<topic>/<slug>-<id>.md
    checkpoints/<context-slug>/<thread-slug>.md
  index.sqlite                rebuildable search index, plus the recall log
```

The embedding model cache lives apart, under `SATCHEL_MODELS` (default `./models`,
`/models` in the container). It is downloaded on first run and safe to lose.

The server creates `repo/` (with `git init`, an empty `core.md` and `topics.yaml`) on
first start. Every write through the server is one git commit, authored as
`satchel <satchel@localhost>`, with the client name in the message. The owner may edit
files directly; the server notices (file watch plus a rescan at startup) and reindexes.
Direct edits are not auto-committed.

### Memory file

````markdown
---
id: m_01hzx3k9
topic: code-design
scope: global            # global | context | host
context: github.com/example/app   # only when scope is context
host: nas                # only when scope is host
kind: rule               # rule | fact | event | preference; fact when absent
origin: stated           # stated | inferred | imported; inferred when absent
date: 2026-12-03         # optional; required for kind event
expires: 2027-01-01      # optional
about: [person:alice]    # optional
filetypes: [ts, js]      # optional
tags: [code]             # optional
core: true               # optional; pinned into the core
created: 2026-11-12T18:04:00Z
updated: 2026-11-12T18:04:00Z
source: claude-code      # MCP clientInfo.name of the writer
---
Use an options object instead of a positional boolean: call sites document themselves.

```ts
// BAD
exportReport(report, true)
// GOOD
exportReport(report, { includeDrafts: true })
```
````

- `id`: `m_` plus 8 lowercase base32 characters, random. Checkpoints use `c_`, references
  `r_`.
- The body's first paragraph (up to the first blank line) is the rule or fact, 1 to 5
  sentences. Examples may follow. `MEMORY_MAX_CHARS` is 6,000 for the whole body.
  Embeddings and the similar-memory check use the first paragraph only, so examples do not
  make unrelated rules look alike.
- The filename slug is derived from the first words of the body; the id suffix makes it
  unique. The path is not an identifier: find files by `id`.

### Reference file

````markdown
---
id: r_4kq2m7xa
topic: linting
title: Biome config for the code-style rules
description: biome.json enabling the lint rules that enforce the code-style memories
scope: global
tags: [biome]
format: jsonc            # the content's language; markdown means no fence
created: 2026-11-15T20:00:00Z
updated: 2026-11-15T20:00:00Z
source: claude-code
---
```jsonc
{ "linter": { "rules": { "style": { "useForOf": "warn" } } } }
```
````

- The content is stored verbatim inside one fenced block whose fence is longer than any
  backtick run in the content; `format: markdown` stores it unfenced. `REFERENCE_MAX_CHARS`
  is 64,000. Title at most 120 characters, description at most 300.
- Scope, `context`, `host`, `filetypes`, `tags`, `about` and `expires` work as for
  memories; references have no kind, origin or date. Only the title and description are
  searched; the content is not embedded.

### Checkpoint file

```markdown
---
id: c_7q2m4t8a
context: github.com/example/satchel
thread: main
commit: 3f2a9c1          # only for code threads
updated: 2026-11-12T18:04:00Z
source: claude-code
---
Store and index modules done. Next: wire recall logging into the nightly job.
```

`context` is a free-form string chosen by the client. For a repository the plugin uses
the project id, so a repository's checkpoints and its context-scoped memories share one
name. `thread` is the branch there, and `main` by default elsewhere.
The body (summary) may be empty: after each commit the plugin asks the agent for a
hash-only checkpoint, which keeps any existing summary. At most 3,000 characters.

## Module layout and ownership

```
src/
  types.ts          shared types and the Store interface (the seam between modules)
  config.ts         env parsing, limits
  lead-paragraph.ts a memory's first paragraph, shared by store/ and server/
  store/            files + git + file watching           -> implements Store
  index/            SQLite FTS5, vectors, hybrid ranking   (used only by store/)
  embed/            in-process embedding model             (used only by index/)
  server/           MCP server, tools, instructions, HTTP app
  auth/             request authentication middleware
  main.ts           wiring and startup
plugin/             Claude Code plugin (hooks, skill, MCP config)
scripts/            pnpm sandbox and pnpm mcp (the feedback loop below)
fixtures/           seed data for the sandbox
docs/               this file, deploy.md, plugin-oauth.md
```

`server/` talks to storage only through the `Store` interface in `src/types.ts`.

## MCP surface

Transport: Streamable HTTP at `POST/GET/DELETE /mcp`, stateless where the SDK allows it.
Both protocol eras are served: 2026-07-28 (a `server/discover` probe, then a `_meta`
envelope on every request) and 2025 (the `initialize` handshake). GET and DELETE answer 405.

### `instructions` (`server/discover` or `initialize` result)

Generated per connection. Contains the usage rules, then the topic map, then the labels
lines. Total at most `INSTRUCTIONS_MAX_CHARS` (3,800; Claude Code truncates at 4,096).
When the map does not fit, drop the topics with the fewest memories and end with a line
saying `brief` has the full list. Not every client passes `instructions` to the model (the
spike found claude.ai and Claude Desktop do not; Claude Code does), so the `brief` tool
description must independently say to call it at the start of a conversation, and the
`brief` result ends with the usage rules (everything below except the first bullet).

Rules text (final wording belongs in `src/server/`, keep it short):

- Call `brief` once at the start of a conversation, with the context and thread if known.
- Before work that matches a topic's trigger, call `recall` with that topic.
- Before writing code, unless the brief already loaded them, call `recall` with tag `code`
  and the file types involved (plus tags for libraries in use), and read every page.
- Repository conventions and context memories override global preferences.
- Call `memorize` when the user asks you to remember something, corrects you, states a
  preference, or you learn a non-obvious fact that would have saved time. One fact per
  call. Do not save what the repo or its docs already record.
- Save memories as global unless they are true only of one repository or undertaking
  (scope `context`) or one machine (scope `host`). Preferences and general facts stay global even when learned
  while working on a particular machine.
- Call `checkpoint` when stopping work on a thread (a branch, or any undertaking that
  spans conversations). A recalled checkpoint is a claim about the past: compare its
  commit with the repo before relying on it.

### Tools

All tools return text content written for a model to read (compact, no JSON dumps).

| Tool | Input | Result |
|---|---|---|
| `brief` | `context?`, `thread?`, `host?`, `filetypes?`, `tags?`, `about?` | Core (`core.md`, then the pinned memories the caller can see); topic map with counts; the labels lines and the `About:` line; the machines that have host-scoped memories (and which is the caller's when `host` is given); with `context`, the count of its context-scoped memories and the checkpoint for `thread` (or all of the context's checkpoints), and without it the most recently updated checkpoints, one line each; with `filetypes` or `tags`, a "Loaded for this work" section holding every matching memory in full plus the titles of matching references, paged like `recall`; with `about`, a "Loaded about" section holding every memory about those entities, paged the same way; the usage rules. |
| `recall` | `query?`, `topic?`, `context?`, `host?`, `filetypes?`, `tags?`, `about?`, `kind?`, `limit?`, `offset?` | Matching memories in full, then matching references by title. At least one of `query`, `topic`, `host`, `kind`, `filetypes`, `tags`, `about`. With `query` it searches; without, it lists. `kind` keeps only memories of that kind, and on its own lists every memory of it; references have no kind, so a request with `kind` lists none. Paged (see below). Logs each returned memory id (see "Recall log"). |
| `memorize` | `text`, `topic`, `kind?` (default `fact`), `origin?` (default `inferred`), `date?`, `expires?`, `about?`, `scope?` (default `global`), `context?`, `host?`, `filetypes?`, `tags?`, `core?`, `topic_trigger?`, `replaces?` | Saves and returns the id (the result names the kind and origin saved, defaults included), plus up to 3 similar existing memories so the caller can merge (not on an update that leaves `text` alone, which cannot create a duplicate). Unknown `topic` without `topic_trigger` is an error that lists existing topics. `replaces: <id>` updates that memory in place: every field left out keeps its stored value, so `text` and `topic` become optional (see "Updating in place"). |
| `save_reference` | `title`, `description`, `content`, `format?` (default `markdown`), `topic`, `scope?`, `context?`, `host?`, `filetypes?`, `tags?`, `about?`, `expires?`, `topic_trigger?`, `replaces?` | Saves verbatim material and returns its id. `replaces` updates in place the same way, so `title`, `description` and `content` become optional. |
| `read` | `id` | The full content of a reference (`r_...`), or of a memory (`m_...`). |
| `forget` | `id` | Deletes a memory, reference or checkpoint, and says what it was. |
| `review` | `section?` (`core`, `duplicates` or `unused`), `offset?` | Read-only upkeep report (see "Review"). Without `section`, an overview of all three with the first few entries of each; with it, that section in full, paged like `recall`. |
| `checkpoint` | `context`, `thread?` (default `main`), `commit?`, `summary?`, `done?` | Upserts the checkpoint; the reply says when it replaced an existing one, since the default `thread` makes that easy to do by accident. `done: true` deletes it (thread merged, finished or abandoned). |

Topic names are lowercase kebab-case, at most 32 characters.

#### Updating in place

`memorize` and `save_reference` with `replaces` are patches, not rewrites. A field the
call leaves out keeps the stored value; a field it gives replaces it. To clear a list
(`filetypes`, `tags`, `about`) pass `[]`; to clear `date` or `expires` pass `null`.
`scope` given without `context` or `host` keeps the stored one when the scope still
needs it; `scope: global` drops both. `source` becomes the updating client, `updated`
moves, `created` and `id` stay. A `topic` change moves the file. The new state is
validated as a whole, so a patch can never leave a memory in a state `memorize` would
have refused.

Details:

- `scope: context` requires `context`; `scope: host` requires `host`.
- `kind: event` requires `date`. `date` and `expires` accept `YYYY-MM-DD` or an ISO 8601
  timestamp; a bare day means midnight UTC. A memory is expired once `expires` is not
  after the time of the request.
- `about` on `recall` matches memories (and references) carrying any of the given values.
  Alone, it lists them; with `query`, `topic` or labels it narrows the result.
- A memory is tied to a machine only by `scope: host`. A `host` passed without that scope is
  ignored, never stored, and the plugin never fills `host` into `memorize`. Agents are told
  to use `host` only for facts about that machine itself; a preference stated on a machine
  stays global.
- `recall` without `context` searches every context's memories; with `context` it
  excludes other contexts' context-scoped memories. The same holds for `host`. `host`
  alone lists that machine's host-scoped memories. An unknown `topic` returns nothing.
- `filetypes` and `tags` given to `recall` or `brief` select memories by the matching rule
  above. Combined with `query` or `topic`, they narrow the result further.
- A memory renders as one entry, `- m_x [topic | scope | kind | origin | core | date: … |
  expires: … | filetypes: … | tags: … | about: … | updated] text`, with `kind` and
  `origin` shown only when they are not the defaults and the rest only when set, so a
  plain inferred fact reads `[topic | scope | updated]`. Continuation lines are indented.
- `brief` shows the context's memory count and checkpoints under `## Context <name>`, and
  with no context `## Recent checkpoints`, one line each
  (`- context @ thread (commit, updated): summary`), at most `RECENT_CHECKPOINTS_MAX` (10).
- Rendered dates (`updated` on memory lines, checkpoint times) are in `SATCHEL_TIMEZONE`;
  stored values stay UTC.
- `topic_trigger` on an existing topic is ignored.
- Checkpoints are shown by `brief`, not `recall`.
- Limits: context and thread 200 characters, host 100; commit one token of at most
  64; checkpoint summary 3,000.
- The writer's name is the client's `clientInfo.name`. 2026-07-28 clients send it in every
  request's `_meta` envelope. 2025 clients send it only on `initialize`, and the transport is
  stateless, so for them it is carried in the `Mcp-Session-Id` value and read back on later
  requests. It is a label, not a credential.
- Tool results are text only, with no `structuredContent`, because some clients show the
  structured form to the model in place of the text.

### Paging

`recall` never cuts a memory short and never drops results silently.

- **Listing** (no `query`) returns every match in a fixed order: memories without
  `filetypes` (rules for any file type, such as `tags: [code]`) before file-type-specific
  ones, then the caller's own context and host first, then by topic, then oldest first
  (an import keeps the order of its source), then by id.
- **Search** (`query`) orders by relevance, ties by id, and returns at most `limit`
  (default 8) per page.
- A page holds whole memories until `RECALL_PAGE_MAX_CHARS` (24,000) would be exceeded, or
  `limit` is reached when given (at most 100). It always holds at least one memory. When
  more remain, the page ends with
  `Showing 1–9 of 23. Next page: call recall with the same arguments and offset=9.`
- `brief`'s "Loaded for this work" section uses `BRIEF_LOADED_MAX_CHARS` (32,000) and ends,
  when partial, with `Loaded 12 of 20. Load the rest: call recall with filetypes=[...],
  tags=[...] and offset=12.`
- References are listed after the memories, one line each (`r_... [topic | reference]
  title: description`), at most 20, and are not paged.
- The order is fixed for unchanged data; a memory saved between two pages can shift them.

### Lines clients may parse

`brief` and the `instructions` contain these lines, which the plugin reads:

- `Tags: code (12), rxjs (3)` and `File types: ts (5), py (2)`: every label a memory
  carries, most used first, with counts (at most 40 per line). References are not counted,
  since these lines say what loading can bring in. Omitted when no memory carries one.
- `About: person:alice (4), place:lisbon (2)`, in `brief` only: every `about` value a live
  memory carries, most used first, at most 40. Omitted when none.

### Other HTTP routes

- `GET /healthz` : unauthenticated, returns `ok`.

There is no REST API. Everything goes through `/mcp`.

## Loading by file type and tag

Rules are meant to arrive when the work starts, not when the agent thinks to ask.

- **Any client**: the map shows which tags and file types exist, and the usage rules say to
  `recall` with tag `code` and the file types involved before writing code.
- **Claude Code main session** (plugin): the session-start hook works out the repository's
  main file types (from `git ls-files`), the tag `code` when any of them is a programming
  language, and tags from top-level dependencies (`package.json`, `requirements.txt`; a
  scoped package gives both forms, `@biomejs/biome` -> `biomejs-biome` and `biome`). The
  PreToolUse hook fills them into the main agent's `brief`, so the rules load with the
  brief, which the agent calls dependably.
- **First edit of an unloaded file type** (plugin): a PreToolUse hook on Write, Edit,
  MultiEdit and NotebookEdit refuses the first edit of a file whose type has memories
  this agent has not loaded, once, with the `recall` call to make. The retry is allowed
  whatever happened, so a subagent without the Satchel tools loses one turn, not the edit.
  Which file types and tags have memories comes from the labels lines of the last brief.
- **Subagents** (plugin): a `SubagentStart` hook adds context saying Satchel is available,
  with context, thread and host. Read-only subagents load nothing more; a subagent that
  edits code meets the first-edit check under its own agent id.
- **After compaction or `/clear`**: the session-start hook runs again, clears the main
  agent's loaded state, and the brief reloads the rules.

## Search

- Full text: SQLite FTS5 (`node:sqlite`, built into Node 24), `porter unicode61`, over the
  whole memory body and over reference titles and descriptions.
- Embeddings: computed in-process with `@huggingface/transformers`. Model named by
  `SATCHEL_EMBED_MODEL` (default `Xenova/bge-small-en-v1.5`; `off` disables embeddings).
  The model is downloaded on first use into `$SATCHEL_MODELS`, never baked into
  the image. The server must start and answer with full-text-only results while the
  model downloads, and whenever loading fails. A memory's vector embeds its first
  paragraph.
- Vectors are stored as `Float32Array` blobs in `index.sqlite` beside the model name
  that produced them. On startup, any memory whose stored model name differs from the
  configured one is re-embedded in the background. Similarity is brute-force cosine;
  the store is small and no vector index is wanted.
- Ranking: reciprocal rank fusion of the FTS order and the cosine order.
- `memorize` uses cosine similarity (or FTS when embeddings are off) on the first
  paragraph to report similar existing memories.

`index.sqlite` index tables can be dropped and rebuilt from `repo/` at any time. The
recall log is the exception: it is usage data, kept in the same file but never dropped by
a rebuild.

### Recall log

`recall_log(memory_id, ts, client, via, context)` has one row per memory shown to a client.
`via` says how: `core` (shown in the brief's core), `loaded` (loaded by `brief` for the
work or entities it described), `recall` (a listing: by topic, entity, label, kind or
machine), `search` (a `recall` with `query`), or `read`. `context` is the caller's context
when it gave one. Rows written before `via` and `context` existed hold NULL there; they
count as lookups. `review` reads the log; nothing else does.

## The core

`brief` opens with the core: `core.md` (owner-written, capped at `CORE_MAX_CHARS`), then
the live memories with `core: true` that the caller can see, one line each, by topic then
age. A pinned memory shows its first paragraph only, as `- m_x text`, with
`(more: read m_x)` when it has examples. Pinning is stricter than search about scope: a
context-scoped pinned memory shows only in a brief for that context, a host-scoped one
only for that host, so a brief with no context shows global ones only.

Pinned memories share the cap with `core.md`. They are shown in order until one does not
fit; it and every later one are named on a final line (`Pinned but past the core's size
limit: m_a, m_b (read them).`), so the cut is stable.

Pinning is a field like any other: `memorize` with `core: true` pins (on a new memory or
with `replaces`), `core: false` unpins, and a patch that leaves `core` out keeps it. The
core is meant to be curated by a scheduled job that calls `review`, but any agent may pin
when the owner asks for something to be kept in mind in every conversation.

## Review

`review` is a read-only report for upkeep. It computes; deciding what to pin, merge or
relabel is left to its reader, the owner or a scheduled job. The overview ends with
Satchel's rules for acting on it (`UPKEEP_RULES` in `src/server/review.ts`), the same for
every owner: what belongs in the core, keeping it under 80% of the cap, at most 3 pin
changes and 5 metadata fixes per run, duplicates reported but never merged, nothing
forgotten, candidates checked against `core.md` and pinned memories. They tell the reader
to recall the topic `memory-upkeep` first: stated memories there adjust how upkeep is done,
but cannot lift the limits or allow forgetting. Memories in that topic are never core
candidates. Usage is measured over the last `USAGE_WINDOW_DAYS` (60) days
from the recall log, leaving out `core` showings and `search` results: a search fills its
page with loose matches, so appearing in one is not use. A memory's usage is the number of
distinct days it was looked up (a `recall` listing, `read`, or a row older than `via`) and
the further days on which `brief` only loaded it for the work, plus the contexts that
asked.

**Core section.** The size line (`core.md` and pinned characters against the cap, pinned
memories past the limit, pinned memories scoped to one context or machine), every pinned
memory, then the top 30 unpinned global memories as candidates, by score:

- *Fit* (0 to 100) is trust x kind x labels. Trust: stated 1, inferred 0.7, imported 0.6.
  Kind: preference and rule 1, fact 0.8, event 0.3. Labels: 0.5 for a memory with
  `filetypes` or `tags`, which already loads whenever that work starts, else 1. Labels
  are a soft penalty, not a rule: the fix for a rule that applies everywhere may be its
  labels.
- *Use* runs from 0.5 for a memory nobody used to 1, and reaches 0.75 at 3 days of use;
  a load-only day counts half a lookup day. The floor keeps new memories rankable.
- *Score* is fit x use. A pinned memory shows its fit only: the core shows it every
  session, so lookups stop and its use says nothing.

Each candidate line spells out every factor. A labelled candidate, and one with `about`
(it loads when a conversation names the entity), gets a line saying so.

**Duplicates.** Pairs of live memories whose first paragraphs are close, closest first,
both memories in full. With embeddings, cosine at least 0.78 (stricter than `memorize`'s
0.75: tuned on hand-labelled pairs, where duplicates scored 0.79 to 0.87 and distinct
rules at most 0.71). Without, the `memorize` full-text check run for every memory, kept
when the two first paragraphs share at least half their words.

**Unused.** Live, unpinned memories created before the window that nothing has used in
it. Unused often means hard to find rather than useless, so each gets hints naming what
to check: a rule with no labels (found only by topic or search); a labelled memory (loads
only when sessions pass those labels); a context-scoped memory whose context no session
named in the window (dormant work, not bad metadata); a host-scoped memory (found only
with that host); a topic none of whose memories was used (its trigger may not match how
the work starts). With none of these, it says the metadata looks reasonable.

## Authentication

`src/auth/` exposes one Express middleware. Modes, selected by env, any combination:

- **Cloudflare Access** (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`): verify the
  `Cf-Access-Jwt-Assertion` header with `jose` against
  `https://<team>/cdn-cgi/access/certs`: signature, `aud`, `iss`, expiry. This is the
  production mode. Cloudflare's Managed OAuth handles the OAuth flow in front of the
  server, so the server contains no OAuth code.
- **Static token** (`SATCHEL_TOKEN`): `Authorization: Bearer <token>`, constant-time
  compare. For local development and same-host clients.
- **None** (`SATCHEL_AUTH=none`): only honoured when binding to a loopback address.

With no mode configured the server refuses to start. A failed check returns `401` with
no detail about why.

Production decision (after a deployment spike): every client connects through Managed
OAuth, with no Cloudflare service token and no `SATCHEL_TOKEN`. `SATCHEL_TOKEN` stays for
local development.

## Plugin and OAuth

The Claude Code plugin's hooks run as shell commands, and the OAuth login belongs to Claude
Code's MCP connection, so the hooks never call the server. Instead:

- `SessionStart` works out context, thread, HEAD, host, file types and tags locally and
  tells the agent to call `brief` with them.
- `PreToolUse` on `brief`, `recall` and `checkpoint` fills what the agent left out
  (`updatedInput`), so names do not depend on the model. It never touches `memorize` or
  `save_reference`.
- `PostToolUse` on `brief` records the labels lines; `PreToolUse` on file edits uses them
  for the first-edit check above.
- `PostToolUse` after `git commit` asks the agent for a hash-only `checkpoint`, once per new
  commit, naming the repository the command committed in.
- `SubagentStart` tells subagents Satchel is available.

The hooks keep small state files per session and agent under `CLAUDE_PLUGIN_DATA`: which
labels exist, which this agent has loaded, which edits it has already been asked about.

Claude Code's `mcp_tool` hooks do use the MCP connection, but they are skipped on
`SessionStart` at launch, can only pass fields of the hook's JSON input, and their plain
text output reaches the model only on events such as `UserPromptSubmit`, not on edits.
Test results and the fully automatic options (a credential the hooks hold themselves) are
in `docs/plugin-oauth.md`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SATCHEL_DATA` | `./data` (`/data` in the container) | Data directory: the memories |
| `SATCHEL_MODELS` | `./models` (`/models` in the container) | Embedding model cache |
| `SATCHEL_HOST` | `127.0.0.1` (`0.0.0.0` in the container) | Bind address |
| `SATCHEL_PORT` | `8787` | Port |
| `SATCHEL_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model, or `off` |
| `SATCHEL_TIMEZONE` | `TZ` if it is an IANA zone, else `UTC` | IANA zone for dates in tool results, e.g. `America/Toronto` |
| `SATCHEL_TOKEN` | unset | Static bearer token |
| `CF_ACCESS_TEAM_DOMAIN` | unset | e.g. `example.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | unset | Access application audience tag |
| `SATCHEL_AUTH` | unset | `none` to disable auth on loopback |

Any variable in the table can instead be read from a file, for Docker and Compose secrets:
set `NAME_FILE` (the official Docker images' convention) or `FILE__NAME` (LinuxServer.io's)
to the file's path. Trailing newlines are dropped; the rest of the file is the value. Setting
a variable both directly and from a file is a startup error. The list is `CONFIG_VARIABLES`
in `src/config.ts`; other `*_FILE` variables in the environment are left alone.

The container also reads `PUID`, `PGID` (default `1000`) and `UMASK` (default `022`) in
`docker/entrypoint.sh`: it starts as root, gives the `node` user those ids, makes
`SATCHEL_DATA` and `SATCHEL_MODELS` theirs, and runs the server as that user under `tini`.
Started with `--user`, it skips all of that.

## Feedback loop for agents

An agent changing Satchel needs to see the effect of a change without a deployed server
or a human in the loop. Three pieces, all runnable from the repo with no network once
the embedding model is cached. The first two are built (`scripts/`); `pnpm eval` is not.

1. **`pnpm sandbox`**: starts the real server on a free loopback port against a
   temporary data directory seeded from `fixtures/memories/` (realistic memories across
   topics, all three scopes, several projects and hosts, labelled coding rules with
   examples, a reference and two checkpoints), committed as a git repository the way the
   server keeps its own. It uses token auth whatever the shell sets, prints the URL and a
   random token, writes them to `.satchel-sandbox.json` (git-ignored) for `pnpm mcp`, and
   removes the directory and that file on exit. `--keep` leaves the directory for
   inspection. Embeddings are off unless `--embed`, which shares the model cache in
   `./models` with `pnpm dev`.
2. **`pnpm mcp <tool> '<json args>'`**: a thin command-line MCP client built on the SDK.
   It connects to a running server (the sandbox by default; `--url` and `--token` for
   another one), prints the `instructions` it received with their character count, calls
   one tool, and prints the result exactly as a model would see it. `pnpm mcp --list`
   prints the tool names and descriptions with their character counts, and under each its
   arguments with their descriptions, as a model sees them. This is how an
   agent checks wording, limits and tool output. Exit codes: 0 ok, 1 the tool returned
   an error, 2 the command was invoked wrongly (with the usage text).
3. **`pnpm eval`** (not built yet): retrieval scoring. `fixtures/queries.yaml` holds cases
   of the form `{ query, context?, expect: [memory ids], reject?: [ids] }`, including
   paraphrases that share no keywords with their target. The command runs every case in
   three modes (full-text only, vectors only, fused) and prints recall@3, recall@8 and
   mean reciprocal rank per mode, then the failing cases with what was returned instead.
   `--model <id>` runs the same cases with another embedding model so models can be
   compared before switching. It also scores duplicate detection: pairs of near-duplicate
   facts that `memorize` should report as similar, and unrelated pairs it should not.

Rules for the loop: the eval prints numbers, it does not gate CI, because a threshold on
a few dozen cases would be noise. A change to ranking, the FTS query builder, the
embedding model or the similarity cutoff must quote the before and after numbers in its
commit message. When a real recall misses in daily use, add it as a case first.

## Future plans

Not built. Listed so that nothing built now closes the door on them.

- **More from the review.** `review` (see "Review") reports the core, duplicates and
  unused memories, with the rules for acting on it; the job that acts runs outside the
  server, as an agent with its own OAuth login (Hermes). Still to come:
  splitting oversized topics, and `last_recalled` in listings so the owner sees it too.
- **Topic management.** Rename a topic, rewrite its trigger, merge two topics, through one
  tool or through the consolidation job. Today `topic_trigger` on an existing topic is
  ignored and a mis-named topic is permanent unless the owner edits `topics.yaml` and
  moves the files by hand.
- **Links between memories.** Optional `related: [m_...]` and `supersedes: m_...` in the
  frontmatter, rendered as one line after the memory, so a reader can follow a thread
  without a graph. `supersedes` would let `memorize` keep the old memory as history
  instead of overwriting it.
- Transcript pass: a background job, started by the plugin's session-start hook, that
  reads unprocessed Claude Code transcripts and submits candidate memories. The same
  credential problem as the consolidation job.
- Import of existing Claude Code memory files and the nuggets repo, and of a notebook
  style guide into labelled memories and references, with `origin: imported`.
