# Satchel plugin for Claude Code

Connects Claude Code to a Satchel memory server so the agent uses it without being told to.

- **MCP server** `satchel` at `$SATCHEL_URL/mcp`. Authentication is the server's OAuth
  (Cloudflare Managed OAuth in production): run `/mcp` once and sign in.
- **SessionStart hook**: tells the agent to call `brief` with the current context (the
  project id), thread (the branch), host (this machine's short hostname) and the work the
  repository involves: its main file
  types, the tag `code` when they include code, and tags from top-level dependencies
  (`package.json`, `requirements.txt`). The rules for that work then load with the brief.
  Prints the HEAD commit so the agent can judge the checkpoint, and says when a memory
  belongs to this machine only. After compaction or `/clear` it runs again, and the brief
  reloads the rules.
- **PreToolUse hook** on `brief`, `recall` and `checkpoint`: fills `context`, `thread`,
  `commit` and `host` and, for the main agent's `brief`, the work's `filetypes` and `tags`
  when the agent leaves them out, so names always match. It records what each agent loads. It
  never touches `memorize` or `save_reference`: tying a memory to a machine or to some work
  is the agent's decision.
- **PostToolUse hook** on `brief`: records which file types and tags have rules, from the
  brief's `Tags:` and `File types:` lines.
- **PreToolUse hook** on Write, Edit, MultiEdit and NotebookEdit: before an agent's first
  edit of a file type whose rules it has not loaded, refuses the edit once, saying which
  `recall` loads them. The retry goes through regardless. This is how a subagent, or the main
  agent editing a file type outside the repository's main ones, gets the rules.
- **SubagentStart hook**: tells each subagent Satchel is available and where it is working.
- **PostToolUse hook** on `git commit`: asks the agent to record a hash-only checkpoint
  (`context`, `thread`, `commit`, no summary), once per new commit.
- **SessionEnd hook**: a stub. The transcript pass is not built yet.
- **Skill** `satchel`: when to `recall`, `memorize`, `save_reference` and `checkpoint`.

## Why the hooks only prompt

The hooks never call the server. The OAuth login belongs to Claude Code's MCP connection, and
a shell hook cannot use it. Claude Code's own `mcp_tool` hooks do use that connection, but
they are skipped on `SessionStart` at launch and can only pass fields of the hook's JSON
input, which has no git origin or branch. So the hooks work out the git facts locally and the
agent makes the calls; the PreToolUse hook makes the arguments exact. See
`docs/plugin-oauth.md` for the test results and the fully automatic options left for later.

The hooks need `sh`, `git` and `jq`. Without `jq` the session-start, commit and subagent
hooks still work; the argument filling, the label recording and the first-edit check do
nothing, and the agent's own arguments are used. The hooks make no network calls and print
nothing when `SATCHEL_URL` is unset.

They keep small state files per session and agent under `CLAUDE_PLUGIN_DATA` (or a
`satchel-plugin` directory in the temp directory): which labels have rules, which ones each
agent has loaded, and which first edits it has already been asked about.

## Install

From a local clone:

```
/plugin marketplace add /path/to/satchel
/plugin install satchel@satchel-plugins
```

From git (replace with the real URL):

```
/plugin marketplace add <git-url-or-owner/repo>
/plugin install satchel@satchel-plugins
```

Shell equivalents: `claude plugin marketplace add <path-or-url>` and
`claude plugin install satchel@satchel-plugins`. Restart Claude Code afterwards.

## Configuration

Set `SATCHEL_URL` in the shell that starts Claude Code (or under `env` in
`~/.claude/settings.json`): the base URL of the server, no trailing path, e.g.
`https://satchel.example.com`. Then run `/mcp`, select `satchel` and sign in.

If the same server is already configured elsewhere (user, project or managed MCP config),
Claude Code connects that definition and skips the plugin's duplicate; the hooks work with
either, as long as `SATCHEL_URL` is set.

Local development against a server started with `SATCHEL_TOKEN=dev` has no OAuth. Add the
server yourself with the token as a header; it takes precedence over the plugin's copy:

```bash
claude mcp add --transport http satchel http://127.0.0.1:8787/mcp --header "Authorization: Bearer dev"
export SATCHEL_URL=http://127.0.0.1:8787
```

## Turning off built-in auto memory (optional, later)

Once you trust Satchel, you can stop Claude Code writing its own memory files so there is
one store. In `~/.claude/settings.json`:

```json
{ "autoMemoryEnabled": false }
```

Leave this for later; the two can run side by side. The setting is documented on
https://code.claude.com/docs/en/memory.md, which also gives `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
as the environment-variable form.

## Notes

- The context is the project id: the `origin` remote reduced to `host/owner/repo`,
  lower-cased, without `.git`; with no remote it is the directory name. The thread is the
  branch.
- The PreToolUse hook fills arguments only for the local context. A call that names another
  context (a `checkpoint` for work outside the repository, say) is left as written, and so
  is a call that already has every argument.
- When it rewrites a call it also approves it, so `brief` and `checkpoint` run without a
  permission prompt. A call it leaves alone goes through the normal permission rules.
- On a detached HEAD the commit hook stays silent, and the brief covers all checkpoints of
  the context.
- The commit hook reads the Bash command itself rather than trusting the `if` filter, which
  also lets through commands Claude Code cannot analyse (a `~` in an assignment,
  `${VAR:-x}`). It finds the repository from the command's `cd <dir>` and `git -C <dir>`,
  since the hook's `cwd` is the session's directory, not one the command moved into, and
  accepts `git -c key=value commit`. It stays silent when HEAD is more than 10 minutes old
  (the commit failed) and for a commit it already asked about. A path built from a shell
  variable cannot be resolved, so that commit is left to the agent's own `checkpoint` at
  the end of work.
