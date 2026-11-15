---
name: satchel
description: How to use the Satchel memory server (MCP tools brief, recall, remember, forget, checkpoint). Use when the user mentions memory, remembering or forgetting something, preferences or corrections to keep, resuming work on a branch, or when a topic in the Satchel topic map matches the task.
---

# Using Satchel memory

Satchel is the user's long-term memory, shared by all their agents. Use it instead of any
built-in auto memory. The tools come from the `satchel` MCP server.

## At the start

- Call `brief` once, before other work. The session-start hook names the project and
  branch to pass; if it did not run, use the `origin` remote as `host/owner/repo` (else the
  directory name) and the current branch. Missing arguments may be filled in from git.
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
- After each `git commit` a hook asks you to record the new commit. Call `checkpoint` with
  the project, branch and commit it gives and no `summary`, so the stored summary is kept.
- Use `done: true` once the branch is merged or deleted.
- A checkpoint is a claim about the past. Compare its commit with HEAD (`git log`) before
  relying on it. The session-start hook prints the HEAD commit.

## Do not

- Do not save secrets or tokens.
- Do not recall on every turn. Recall when a trigger matches.
