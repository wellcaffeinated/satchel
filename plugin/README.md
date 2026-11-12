# Satchel plugin for Claude Code

Connects Claude Code to a Satchel memory server so the agent uses it without being told to.

- **MCP server** `satchel` at `$SATCHEL_URL/mcp`.
- **SessionStart hook**: prints the memory brief for the current project and branch, plus one
  line saying how the branch checkpoint's commit relates to your working tree.
- **PostToolUse hook**: after the agent runs `git commit`, records a hash-only checkpoint
  (`project`, `branch`, `commit`) in the background.
- **SessionEnd hook**: a stub. The transcript pass is not built yet.
- **Skill** `satchel`: when to `recall`, `remember` and `checkpoint`.

The hooks need only `sh`, `curl` and `git`. They print nothing and exit 0 if the server is
down or `SATCHEL_URL` is unset, and add at most about 3 seconds to session start.

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

## Environment variables

Set these in the shell that starts Claude Code (or under `env` in `~/.claude/settings.json`).

| Variable                                           | Meaning                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SATCHEL_URL`                                      | Base URL of the server, no trailing path, e.g. `http://127.0.0.1:8787` or `https://satchel.example.com`. Required. |
| `SATCHEL_TOKEN`                                    | Static bearer token. Same-host or dev setups (server has `SATCHEL_TOKEN`).                                         |
| `SATCHEL_CF_CLIENT_ID`, `SATCHEL_CF_CLIENT_SECRET` | Cloudflare Access service token, for headless use. Both are needed.                                                |

Pick one auth setup:

1. **Bearer token**: set `SATCHEL_URL` and `SATCHEL_TOKEN`.
2. **Cloudflare service token**: set `SATCHEL_URL`, `SATCHEL_CF_CLIENT_ID`, `SATCHEL_CF_CLIENT_SECRET`.
3. **Interactive OAuth**: set only `SATCHEL_URL`. Run `/mcp` in Claude Code and sign in to
   `satchel`. This needs Managed OAuth on the Access application (see `docs/host-setup.md`).

The MCP connection takes its headers from `scripts/mcp-headers.sh`, which prints only the
headers whose variables are set. When none are set it prints `{}`, so OAuth stays possible.
The hooks use the same variables, so with OAuth only (no token or service token) the hooks
get 401 and stay silent: set a service token or token as well if you want the brief and
commit checkpoints.

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

- The hook project name is the `origin` remote reduced to `host/owner/repo`, lower-cased,
  without `.git`; with no remote it is the directory name.
- On a detached HEAD the commit hook records nothing, and the session brief covers all
  checkpoints of the project.
- The commit hook matches `git commit ...`; a commit made as `git -C dir commit` does not
  trigger it. The agent's own `checkpoint` call still works.
