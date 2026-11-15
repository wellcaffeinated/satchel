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

1. **Core**: `core.md`, standing facts and preferences that apply everywhere. Hard cap
   `CORE_MAX_CHARS` (4,000). Loaded by `brief`. Only the owner edits it.
2. **Map**: one line per topic: name, trigger ("read before ..."), counts. Rendered from
   `topics.yaml` plus counts. Loaded in MCP `instructions` and by `brief`, followed by the
   tags and file types in use (with counts) and, in `brief`, the machines that have
   host-scoped memories.
3. **Memories**: one rule or fact per file. The first paragraph states it; examples, such
   as code blocks, may follow. Fetched through `recall`, or loaded by `brief` when their
   labels match the work (see "Loading by file type and tag").
4. **References**: verbatim material an agent consults or copies (a `biome.json`, a
   template, a checklist), with a title and a one-line description. Never loaded
   automatically: `recall` lists them by title, `read` returns the content.

A **checkpoint** records where work left off on one branch of one project. There is one
per `(project, branch)`, overwritten on each update.

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

Everything lives under `SATCHEL_DATA` (default `./data`, `/data` in the container):

```
$SATCHEL_DATA/
  repo/                       git repository, the source of truth
    core.md
    topics.yaml               { <topic>: { trigger: "<one line>" } }
    memories/<topic>/<slug>-<id>.md
    references/<topic>/<slug>-<id>.md
    checkpoints/<project-slug>/<branch-slug>.md
  index.sqlite                rebuildable search index, plus the recall log
  models/                     embedding model cache, downloaded on first run
```

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
scope: global            # global | project | host
project: github.com/example/app   # only when scope is project
host: nas                # only when scope is host
filetypes: [ts, js]      # optional
tags: [code]             # optional
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
- Scope, `project`, `host`, `filetypes` and `tags` work as for memories. Only the title and
  description are searched; the content is not embedded.

### Checkpoint file

```markdown
---
id: c_7q2m4t8a
project: github.com/example/satchel
branch: main
commit: 3f2a9c1
updated: 2026-11-12T18:04:00Z
source: claude-code
---
Store and index modules done. Next: wire recall logging into the nightly job.
```

`project` is a free-form string chosen by the client. The plugin uses the `origin`
remote reduced to `host/owner/repo`, or the directory name when there is no remote.
The body (summary) may be empty: after each commit the plugin asks the agent for a
hash-only checkpoint, which keeps any existing summary. At most 3,000 characters.

## Module layout and ownership

```
src/
  types.ts          shared types and the Store interface (the seam between modules)
  config.ts         env parsing, limits
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

### `instructions` (initialize result)

Generated per connection. Contains the usage rules, then the topic map, then the labels
lines. Total at most `INSTRUCTIONS_MAX_CHARS` (3,800; Claude Code truncates at 4,096).
When the map does not fit, drop the topics with the fewest memories and end with a line
saying `brief` has the full list. Not every client passes `instructions` to the model (the
spike found claude.ai and Claude Desktop do not; Claude Code does), so the `brief` tool
description must independently say to call it at the start of a conversation, and the
`brief` result ends with the usage rules (everything below except the first bullet).

Rules text (final wording belongs in `src/server/`, keep it short):

- Call `brief` once at the start of a conversation, with the project and branch if known.
- Before work that matches a topic's trigger, call `recall` with that topic.
- Before writing code, unless the brief already loaded them, call `recall` with tag `code`
  and the file types involved (plus tags for libraries in use), and read every page.
- Repository conventions and project memories override global preferences.
- Call `memorize` when the user asks you to remember something, corrects you, states a
  preference, or you learn a non-obvious fact that would have saved time. One fact per
  call. Do not save what the repo or its docs already record.
- Save memories as global unless they are true only of one repository (scope `project`) or
  one machine (scope `host`). Preferences and general facts stay global even when learned
  while working on a particular machine.
- Call `checkpoint` when stopping work on a branch. A recalled checkpoint is a claim
  about the past: compare its commit with the repo before relying on it.

### Tools

All tools return text content written for a model to read (compact, no JSON dumps).

| Tool | Input | Result |
|---|---|---|
| `brief` | `project?`, `branch?`, `host?`, `filetypes?`, `tags?` | Core; topic map with counts; the labels lines; the machines that have host-scoped memories (and which is the caller's when `host` is given); with `filetypes` or `tags`, a "Loaded for this work" section holding every matching memory in full plus the titles of matching references, paged like `recall`; with `project`, the checkpoint for `branch` (or all of the project's checkpoints) and the count of project-scoped memories; the usage rules. |
| `recall` | `query?`, `topic?`, `project?`, `host?`, `filetypes?`, `tags?`, `limit?`, `offset?` | Matching memories in full, then matching references by title. At least one of `query`, `topic`, `host`, `filetypes`, `tags`. With `query` it searches; without, it lists. Paged (see below). Logs each returned memory id. |
| `memorize` | `text`, `topic`, `scope?` (default `global`), `project?`, `host?`, `filetypes?`, `tags?`, `topic_trigger?`, `replaces?` | Saves and returns the id, plus up to 3 similar existing memories so the caller can merge. Unknown `topic` without `topic_trigger` is an error that lists existing topics. `replaces: <id>` rewrites that memory in place. |
| `save_reference` | `title`, `description`, `content`, `format?` (default `markdown`), `topic`, `scope?`, `project?`, `host?`, `filetypes?`, `tags?`, `topic_trigger?`, `replaces?` | Saves verbatim material and returns its id. |
| `read` | `id` | The full content of a reference (`r_...`), or of a memory (`m_...`). |
| `forget` | `id` | Deletes a memory, reference or checkpoint. |
| `checkpoint` | `project`, `branch`, `commit`, `summary?`, `done?` | Upserts the checkpoint. `done: true` deletes it (branch merged or removed). |

Topic names are lowercase kebab-case, at most 32 characters.

Details:

- `scope: project` requires `project`; `scope: host` requires `host`.
- A memory is tied to a machine only by `scope: host`. A `host` passed without that scope is
  ignored, never stored, and the plugin never fills `host` into `memorize`. Agents are told
  to use `host` only for facts about that machine itself; a preference stated on a machine
  stays global.
- `recall` without `project` searches every project's memories; with `project` it
  excludes other projects' project-scoped memories. The same holds for `host`. `host`
  alone lists that machine's host-scoped memories. An unknown `topic` returns nothing.
- `filetypes` and `tags` given to `recall` or `brief` select memories by the matching rule
  above. Combined with `query` or `topic`, they narrow the result further.
- `topic_trigger` on an existing topic is ignored.
- Checkpoints are shown by `brief`, not `recall`.
- Limits: project, host and branch 200 characters; commit one token of at most 64;
  checkpoint summary 3,000.
- The transport is stateless, so the writer's name from `initialize` is carried in the
  `Mcp-Session-Id` value and read back on later requests. It is a label, not a credential.
- Tool results are text only, with no `structuredContent`, because some clients show the
  structured form to the model in place of the text.

### Paging

`recall` never cuts a memory short and never drops results silently.

- **Listing** (no `query`) returns every match in a fixed order: memories without
  `filetypes` (rules for any file type, such as `tags: [code]`) before file-type-specific
  ones, then the caller's own project and host first, then by topic, then oldest first
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
  with project, branch and host. Read-only subagents load nothing more; a subagent that
  edits code meets the first-edit check under its own agent id.
- **After compaction or `/clear`**: the session-start hook runs again, clears the main
  agent's loaded state, and the brief reloads the rules.

## Search

- Full text: SQLite FTS5 (`node:sqlite`, built into Node 24), `porter unicode61`, over the
  whole memory body and over reference titles and descriptions.
- Embeddings: computed in-process with `@huggingface/transformers`. Model named by
  `SATCHEL_EMBED_MODEL` (default `Xenova/bge-small-en-v1.5`; `off` disables embeddings).
  The model is downloaded on first use into `$SATCHEL_DATA/models`, never baked into
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
`recall_log(memory_id, ts, client)` table is the exception: it is usage data, kept in
the same file but never dropped by a rebuild.

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

- `SessionStart` works out project, branch, HEAD, host, file types and tags locally and
  tells the agent to call `brief` with them.
- `PreToolUse` on `brief`, `recall` and `checkpoint` fills what the agent left out
  (`updatedInput`), so names do not depend on the model. It never touches `memorize` or
  `save_reference`.
- `PostToolUse` on `brief` records the labels lines; `PreToolUse` on file edits uses them
  for the first-edit check above.
- `PostToolUse` after `git commit` asks the agent for a hash-only `checkpoint`.
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
| `SATCHEL_DATA` | `./data` | Data directory |
| `SATCHEL_HOST` | `127.0.0.1` (`0.0.0.0` in the container) | Bind address |
| `SATCHEL_PORT` | `8787` | Port |
| `SATCHEL_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model, or `off` |
| `SATCHEL_TOKEN` | unset | Static bearer token |
| `CF_ACCESS_TEAM_DOMAIN` | unset | e.g. `example.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | unset | Access application audience tag |
| `SATCHEL_AUTH` | unset | `none` to disable auth on loopback |

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
   `./data/models` with `pnpm dev`.
2. **`pnpm mcp <tool> '<json args>'`**: a thin command-line MCP client built on the SDK.
   It connects to a running server (the sandbox by default; `--url` and `--token` for
   another one), prints the `instructions` it received with their character count, calls
   one tool, and prints the result exactly as a model would see it. `pnpm mcp --list`
   prints the tool names and descriptions with their character counts. This is how an
   agent checks wording, limits and tool output. Exit codes: 0 ok, 1 the tool returned
   an error, 2 the command was invoked wrongly (with the usage text).
3. **`pnpm eval`** (not built yet): retrieval scoring. `fixtures/queries.yaml` holds cases
   of the form `{ query, project?, expect: [memory ids], reject?: [ids] }`, including
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

## Not built yet

- Transcript pass: a background job, started by the plugin's session-start hook, that
  reads unprocessed Claude Code transcripts and submits candidate memories. Submitting
  needs a credential a background job can use; with OAuth only, that means one of the
  automatic options in `docs/plugin-oauth.md`.
- Nightly consolidation: merge duplicates, split oversized topics, rewrite triggers,
  promote often-recalled memories into core. Uses `recall_log`.
- Import of existing Claude Code memory files and the nuggets repo, and of a notebook
  style guide into labelled memories and references.
