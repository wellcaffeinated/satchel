# Satchel design

Satchel is a self-hosted memory service for AI agents. One server holds one person's
memories and serves them to any MCP client. This file is the contract the code is built
against; when code and this file disagree, fix one of them in the same change.

## Goals

- One store, reachable from every agent the owner uses (Claude Code, claude.ai, Claude
  Desktop and mobile, Hermes, anything else that speaks MCP).
- A small, fixed-size start-of-session load that tells an agent what it can look up.
- Agents decide when to save; the owner never has to review, but can browse and edit.
- Plain files as the source of truth. Everything else is a cache that can be rebuilt.
- Standard protocols only in the server: MCP over Streamable HTTP. Nothing in `src/` is
  specific to one client. Client-specific glue lives in `plugin/`.
- Runs as one Docker container with one mounted volume.

## The three tiers

1. **Core**: `core.md`, standing facts and preferences that apply everywhere. Hard cap
   `CORE_MAX_CHARS` (4,000). Loaded by `brief`.
2. **Map**: one line per topic: name, trigger ("read before ..."), memory count. Rendered
   from `topics.yaml` plus counts. Loaded in MCP `instructions` and by `brief`.
3. **Memories**: one fact per file, fetched only through `recall`.

A **checkpoint** records where work left off on one branch of one project. There is one
per `(project, branch)`, overwritten on each update.

## Data directory

Everything lives under `SATCHEL_DATA` (default `./data`, `/data` in the container):

```
$SATCHEL_DATA/
  repo/                       git repository, the source of truth
    core.md
    topics.yaml               { <topic>: { trigger: "<one line>" } }
    memories/<topic>/<slug>-<id>.md
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

```markdown
---
id: m_01hzx3k9
topic: svelte
scope: global            # global | project | host
project: github.com/wellcaffeinated/wefty   # only when scope is project
host: roastery           # only when scope is host
created: 2026-11-12T18:04:00Z
updated: 2026-11-12T18:04:00Z
source: claude-code      # MCP clientInfo.name of the writer
---
Function bindings in Svelte 5 write to the getter's target, not the local variable.
```

- `id`: `m_` plus 8 lowercase base32 characters, random. Checkpoints use `c_`.
- The body is the fact, 1 to 5 sentences. `MEMORY_MAX_CHARS` is 1,500.
- The filename slug is derived from the first words of the body; the id suffix makes it
  unique. The path is not an identifier: find files by `id`.

### Checkpoint file

```markdown
---
id: c_7q2m4t8a
project: github.com/wellcaffeinated/satchel
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
hash-only checkpoint, which keeps any existing summary.

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
docs/               this file, deploy.md, plugin-oauth.md
```

`server/` talks to storage only through the `Store` interface in `src/types.ts`.

## MCP surface

Transport: Streamable HTTP at `POST/GET/DELETE /mcp`, stateless where the SDK allows it.

### `instructions` (initialize result)

Generated per connection. Contains the usage rules, then the topic map. Total at most
`INSTRUCTIONS_MAX_CHARS` (3,800; Claude Code truncates at 4,096). When the map does not
fit, drop the topics with the fewest memories and end with a line saying `brief` has the
full list. Not every client passes `instructions` to the model (the spike found claude.ai
and Claude Desktop do not; Claude Code does), so the `brief` tool description must
independently say to call it at the start of a conversation, and the `brief` result ends
with the usage rules (everything below except the first bullet).

Rules text (final wording belongs in `src/server/`, keep it short):

- Call `brief` once at the start of a conversation, with the project and branch if known.
- Before work that matches a topic's trigger, call `recall` with that topic.
- Call `remember` when the user corrects you, states a preference, or you learn a
  non-obvious fact that would have saved time. One fact per call. Do not save what the
  repo or its docs already record.
- Call `checkpoint` when stopping work on a branch. A recalled checkpoint is a claim
  about the past: compare its commit with the repo before relying on it.

### Tools

All tools return text content written for a model to read (compact, no JSON dumps).

| Tool | Input | Result |
|---|---|---|
| `brief` | `project?`, `branch?` | Core, topic map with counts, and when `project` is given: the checkpoint for `branch` (or all checkpoints of the project when no branch) and the count of project-scoped memories. |
| `recall` | `query?`, `topic?`, `project?`, `limit?` (default 8, max 25) | Matching memories with id, topic, scope, updated date. At least one of `query`, `topic`. With `project`, that project's memories rank first; other projects' project-scoped memories are excluded. Logs each returned id. |
| `remember` | `text`, `topic`, `scope?` (default `global`), `project?`, `host?`, `topic_trigger?`, `replaces?` | Saves and returns the id, plus up to 3 similar existing memories so the caller can merge. Unknown `topic` without `topic_trigger` is an error that lists existing topics. `replaces: <id>` rewrites that memory in place. |
| `forget` | `id` | Deletes a memory or checkpoint. |
| `checkpoint` | `project`, `branch`, `commit`, `summary?`, `done?` | Upserts the checkpoint. `done: true` deletes it (branch merged or removed). |

Topic names are lowercase kebab-case, at most 32 characters.

Details settled during the first build:

- `scope: project` requires `project`; `scope: host` requires `host`.
- `recall` without `project` searches every project's memories; with `project` it
  excludes other projects' project-scoped memories. An unknown `topic` returns nothing.
- `topic_trigger` on an existing topic is ignored.
- Checkpoints are shown by `brief`, not `recall`.
- Limits: project, host and branch 200 characters; commit one token of at most 64;
  checkpoint summary 3,000.
- The transport is stateless, so the writer's name from `initialize` is carried in the
  `Mcp-Session-Id` value and read back on later requests. It is a label, not a credential.
- Tool results are text only, with no `structuredContent`, because some clients show the
  structured form to the model in place of the text.

### Other HTTP routes

- `GET /healthz` : unauthenticated, returns `ok`.

There is no REST API. The `GET /api/brief` and `POST /api/checkpoint` endpoints existed
for the plugin's curl hooks; with OAuth as the only production auth a shell hook cannot
use them (see "Plugin and OAuth" below), so they were removed. Everything goes through
`/mcp`.

## Search

- Full text: SQLite FTS5 (`node:sqlite`, built into Node 24), `porter unicode61`.
- Embeddings: computed in-process with `@huggingface/transformers`. Model named by
  `SATCHEL_EMBED_MODEL` (default `Xenova/bge-small-en-v1.5`; `off` disables embeddings).
  The model is downloaded on first use into `$SATCHEL_DATA/models`, never baked into
  the image. The server must start and answer with full-text-only results while the
  model downloads, and whenever loading fails.
- Vectors are stored as `Float32Array` blobs in `index.sqlite` beside the model name
  that produced them. On startup, any memory whose stored model name differs from the
  configured one is re-embedded in the background. Similarity is brute-force cosine;
  the store is small and no vector index is wanted.
- Ranking: reciprocal rank fusion of the FTS order and the cosine order.
- `remember` uses cosine similarity (or FTS when embeddings are off) to report similar
  existing memories.

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

Production decision (after a deployment spike): every client connects through Managed
OAuth, with no Cloudflare service token and no `SATCHEL_TOKEN`. `SATCHEL_TOKEN` stays for
local development.
- **None** (`SATCHEL_AUTH=none`): only honoured when binding to a loopback address.

With no mode configured the server refuses to start. A failed check returns `401` with
no detail about why.

## Plugin and OAuth

The Claude Code plugin's hooks run as shell commands, and the OAuth login belongs to Claude
Code's MCP connection, so the hooks never call the server. Instead:

- `SessionStart` works out project, branch and HEAD from git and tells the agent to call
  `brief` with them.
- `PreToolUse` on `brief` and `checkpoint` fills missing `project`, `branch` and `commit`
  from git (`updatedInput`), so project names do not depend on the model.
- `PostToolUse` after `git commit` asks the agent for a hash-only `checkpoint`.

Claude Code's `mcp_tool` hooks do use the MCP connection, but they are skipped on
`SessionStart` at launch and can only pass fields of the hook's JSON input, which carries
no git origin or branch. Test results and the fully automatic options (a credential the
hooks hold themselves) are in `docs/plugin-oauth.md`.

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
   temporary data directory seeded from `fixtures/memories/` (32 memories across eight
   topics, all three scopes and three example projects, plus two checkpoints), committed
   as a git repository the way the server keeps its own. It uses token auth whatever the
   shell sets, prints the URL and a random token, writes them to `.satchel-sandbox.json`
   (git-ignored) for `pnpm mcp`, and removes the directory and that file on exit.
   `--keep` leaves the directory for inspection. Embeddings are off unless `--embed`,
   which shares the model cache in `./data/models` with `pnpm dev`.
2. **`pnpm mcp <tool> '<json args>'`**: a thin command-line MCP client built on the SDK.
   It connects to a running server (the sandbox by default; `--url` and `--token` for
   another one), prints the `instructions` it received with their character count, calls
   one tool, and prints the result exactly as a model would see it. `pnpm mcp --list`
   prints the tool names and descriptions with their character counts. This is how an
   agent checks wording, limits and tool output. Exit codes: 0 ok, 1 the tool returned
   an error, 2 the command was invoked wrongly (with the usage text).
3. **`pnpm eval`** (not built yet): retrieval scoring. `fixtures/queries.yaml` holds cases of the form
   `{ query, project?, expect: [memory ids], reject?: [ids] }`, including paraphrases that
   share no keywords with their target. The command runs every case in three modes
   (full-text only, vectors only, fused) and prints recall@3, recall@8 and mean
   reciprocal rank per mode, then the failing cases with what was returned instead.
   `--model <id>` runs the same cases with another embedding model so models can be
   compared before switching. It also scores duplicate detection: pairs of near-duplicate
   facts that `remember` should report as similar, and unrelated pairs it should not.

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
- Import of existing Claude Code memory files and the nuggets repo.
