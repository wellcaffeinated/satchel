---
name: satchel
description: How to use the Satchel memory server (MCP tools brief, recall, remember, forget, checkpoint). Use when the user mentions memory, remembering or forgetting something, preferences or corrections to keep, resuming work on a branch, or when a topic in the Satchel topic map matches the task.
---

# Using Satchel memory

Satchel is the user's long-term memory, shared by all their agents. Use it instead of any
built-in auto memory. The tools come from the `satchel` MCP server.

## At the start

- The session-start hook prints a brief. If it did not run, call `brief` with the
  project and branch.
- The brief lists topics, each with a "read before ..." trigger. Before work that matches
  a trigger, call `recall` with that topic. Use `query` for anything not covered by a topic.

## When to remember

Call `remember` when:

- the user corrects you or states a preference,
- you learn a non-obvious fact that would have saved you time.

Rules:

- One fact per call, one to five sentences, written so it makes sense without this chat.
- Do not save what the repo, its docs, or git history already say.
- Pick an existing topic. A new topic needs `topic_trigger`, one line starting "read before".
- Scope: `global` by default; `project` for facts about one repository; `host` for one machine.
- Read the "similar" list in the reply. If one of them covers the same fact, call `remember`
  again with `replaces: <id>` to merge into it. Do not leave duplicates.
- If a recalled memory is wrong or stale, fix it with `replaces`, or `forget` it.

## Checkpoints

- When you stop work on a branch, call `checkpoint` with `project`, `branch`, `commit`, and a
  `summary`: what is done, what is next, what is half-finished.
- A hook records the commit hash after each `git commit`. It keeps your summary.
- Use `done: true` once the branch is merged or deleted.
- A checkpoint is a claim about the past. Compare its commit with `git log` before relying
  on it. The session-start hook prints one line saying how far behind HEAD it is.

## Do not

- Do not save secrets or tokens.
- Do not recall on every turn. Recall when a trigger matches.
