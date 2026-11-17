---
name: satchel
description: How to use the Satchel memory server (MCP tools brief, recall, memorize, save_reference, read, forget, checkpoint). Use when the user mentions memory, remembering or forgetting something, preferences or corrections to keep, resuming work on a branch or any undertaking, people, places, dates or plans worth keeping, or when a topic in the Satchel topic map matches the task.
---

# Using Satchel memory

Satchel is the user's long-term memory, shared by all their agents. Use it instead of any
built-in auto memory. The tools come from the `satchel` MCP server.

## At the start

- Call `brief` once, before other work. The session-start hook names the `context` (the
  project id) and `thread` (the branch) to pass; if it did not run, use the `origin` remote
  as `host/owner/repo` (else the directory name) and the current branch, plus `host`, this
  machine's short hostname. Missing arguments may be filled in from git and the hostname.
  Outside a repository, `context` is a short name for the undertaking.
- When the conversation is about particular people, places or things, pass `about`
  (`["person:alice"]`) to the brief: what is known about them loads in full.
- The brief lists topics, each with a "read before ..." trigger. Before work that matches
  a trigger, call `recall` with that topic. Use `query` for anything not covered by a topic.
- In a repository, the brief also loads the rules for the work: the session-start hook
  passes its file types and tags (`code`, library names), and the brief's "Loaded for this
  work" section holds those rules in full. Follow them. If it ends with "Load the rest",
  make that `recall` call.

## Rules for the code you write

- Rules for code are memories labelled with `filetypes` (`ts`, `py`) or `tags` (`code` for
  any language, a library such as `rxjs`). The brief loads the ones for the repository.
- Before writing a file type the brief did not load, call `recall` with that file type and
  `tags: ["code"]`. A hook asks for this before your first edit of such a file; do it, then
  make the edit again.
- `recall` returns whole memories in pages. When a page ends with "Next page", call again
  with that `offset` until you have them all.
- Repository conventions (its AGENTS.md, linter config) and context memories override global
  preferences.

## When to memorize

Call `memorize` when:

- the user asks you to remember something,
- the user corrects you or states a preference,
- you learn a non-obvious fact that would have saved you time.

Rules:

- One rule or fact per call, stated in a first paragraph of one to five sentences, written
  so it makes sense without this chat. Examples may follow, such as a short BAD/GOOD code
  block, when the rule is unclear without one.
- Do not save what the repo, its docs, or git history already say.
- Pick an existing topic. A new topic needs `topic_trigger`, one line starting "read before".
- Say what kind of memory it is: `rule` (how to do something; most carry labels), `fact`
  (the default), `event` (something that happened or will happen, with `date`), or
  `preference` (what the user likes or wants). Set `origin: stated` when the user said it in
  so many words; leave the default `inferred` when you concluded it. Only say "you told me"
  about a `stated` memory.
- Name who or what it concerns in `about`, as `name` or `kind:name` (`person:alice`,
  `place:lisbon`, `project:garden-shed`). `recall` with `about` lists everything about them.
  Use `about` for people, places and things; use `tags` only for work that rules load for.
- `core: true` pins a memory into the core every brief shows. Use it only when the user asks
  for something to be kept in mind in every conversation; a scheduled job curates the rest.
- Set `expires` on anything perishable (a plan, an offer, a temporary setup). Expired
  memories disappear from `recall` and the brief on their own.
- Scope: `global` by default, and for anything not tied to one context or one machine.
  - `context` only for facts about that repository or undertaking (its layout, conventions,
    decisions).
  - `host` only for facts about that machine itself: its setup, paths, services, hardware.
  - Where you happen to be running is not a reason to use `host`. "The user likes cheese"
    is global even when it was said on the desktop; "the desktop runs Docker rootless" is
    `host: desktop`. When unsure, use `global`.
- Labels: set `filetypes` or `tags` only when the rule applies only to that work, so it
  loads automatically there. A rule about code in any language gets `tags: ["code"]`; a
  TypeScript-only rule gets `filetypes: ["ts", "tsx"]`; an RxJS rule gets both
  `filetypes: ["ts", "js"]` and `tags: ["rxjs"]`. A general preference gets no labels.
- Pass `context` and `host` to `recall` so this context's and machine's memories come first
  and other machines' stay out. The brief lists which machines have memories of their own; `recall` with only
  `host` lists what is known about one of them.
- Read the "similar" list in the reply. If one of them covers the same fact, call `memorize`
  again with `replaces: <id>` and the combined text to merge into it, then `forget` the new
  one. Do not leave duplicates.
- If a recalled memory is wrong or stale, fix it with `replaces`, or `forget` it. A call with
  `replaces` is a patch: give only the fields that change, and the rest keep their stored
  values (`[]` clears a list, `null` clears `date` or `expires`).

## References

- Use `save_reference` for material to consult or copy rather than follow: a config file, a
  template, a checklist. Give a short title and a one-line description of what it is for;
  the content is stored exactly as given, with `format` naming its language.
- `recall` and the brief list references by title; get the content with `read`.
- Rules belong in `memorize`, not in a reference: references are never loaded automatically.

## Checkpoints

- A checkpoint records where work stopped on one `thread` of one `context`: the same values
  the brief took. In a repository the hooks fill both. For work outside a repository (a
  document, a plan, a trip) the context is a short name for the undertaking
  (`grant-proposal`) and the thread is `main` unless there are several lines of work.
- When you stop work, call `checkpoint` with a `summary`: what is done, what is next, what
  is half-finished, and `commit` (HEAD) for code.
- After each `git commit` a hook asks you to record the new commit. Call `checkpoint` with
  the context, thread and commit it gives and no `summary`, so the stored summary is kept.
- Use `done: true` once the branch is merged or deleted, or the undertaking is finished.
- `brief` with `context` and `thread` shows that checkpoint; without them it lists the most
  recent ones.
- A checkpoint is a claim about the past. Compare its commit with HEAD (`git log`) before
  relying on it. The session-start hook prints the HEAD commit.

## Do not

- Do not save secrets or tokens.
- Do not recall on every turn. Recall when a trigger matches.
