# Plugin hooks and OAuth

When every client signs in through OAuth (Cloudflare Access with Managed OAuth in front of
the server), the Claude Code plugin's hooks cannot call the server the way they used to
(plain `curl` with a token). Tested on 2026-11-15 with Claude Code 2.1.325, headless
`claude -p` runs against a test server, and a throwaway repository with a fake `origin`.

## What Claude Code offers

`mcp_tool` hooks (`"type": "mcp_tool"`, with `server`, `tool`, `input`) call a tool over the
session's own MCP connection, so they use its OAuth login. Source: Claude Code docs, "Hooks
reference", "MCP tool hook fields".

| Test | Result |
| --- | --- |
| `mcp_tool` on `SessionStart` at launch | Skipped: "mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)". Documented: it runs only after `/clear` or a compaction. |
| `mcp_tool` on `UserPromptSubmit`, `recall` with `"query": "${prompt}"` | Works; the tool's text reaches the model. Fires on every prompt; there is no way to limit it to the first. |
| `mcp_tool` on `PostToolUse` (`Bash`, `if: "Bash(git commit *)"`) | Works. `${tool_response.stdout}` is `[feat-x 2002f4b] probe` (branch and short hash), `${cwd}` is the local path, an unknown path gives an empty string. There is no field holding the `origin` remote, so the project id cannot be sent. |
| `command` hook on `PreToolUse` for `brief` returning `updatedInput` | Works: the model called `brief` with no arguments and the hook's `project` and `branch` were used. `updatedInput` replaces the whole input, so the hook merges with `jq`. |
| Agent-prompted calls (the design below), Sonnet x2, Haiku, Opus | 4 of 4 called `brief` in the first turn (2 of 4 after the requested commit rather than before it) and `checkpoint` after the commit, with the right project, branch and commit. 3 of 4 overwrote the stored summary when the prompt only said to omit it "unless out of date"; the hook now says "no summary". |

So `mcp_tool` hooks can reach the server but cannot send git facts, and `command` hooks can
compute git facts but cannot reach the server.

## What the plugin does (the hybrid)

- `SessionStart` (`command`, local): prints project, branch and HEAD, and tells the agent to
  call `brief` with them.
- `PreToolUse` on `brief` and `checkpoint` (`command`, local): fills missing `project`,
  `branch` and `commit` from git and approves the call. Only for the local project.
- `PostToolUse` on `git commit` (`command`, local): asks the agent for a hash-only
  `checkpoint`.

The trigger depends on the model following the hook's message; the arguments do not. Cost:
one `brief` call per session and one `checkpoint` call per commit.

## Automatic options for later

For hooks that reach the server with no model in the loop (and for the planned transcript
pass), a hook needs a credential it can use itself. None of these is built or tested.

1. **`cloudflared access login`.** Cloudflare's CLI signs in to an Access application with
   your identity (browser login, no shared secret) and stores an application token;
   `cloudflared access token -app=https://<satchel host>` prints it, and requests
   carry it as the `cf-access-token` header. Needs `cloudflared` on every client and a browser
   login whenever the Access application's session expires. The server already validates the JWT Access forwards, so no server change is
   expected _(unverified with Managed OAuth turned on)_.
2. **A small OAuth client in the plugin** (`satchel login`). It runs the same Managed OAuth
   flow Claude Code runs (dynamic client registration, PKCE, loopback redirect, which the
   Access application must allow), stores the refresh token (valid for the 2-week grant session), and gives
   hooks a fresh access token. The plugin's `headersHelper` could reuse that token for the
   MCP connection, so there would be one login instead of two. Real work: the MCP TypeScript
   SDK's client `auth()` helpers cover discovery, registration, PKCE and refresh, but the
   plugin would need Node on every client, where today it needs only `sh`, `git` and `jq`.
3. **Server-side session context.** If `mcp_tool` hooks share the MCP session with the
   model's calls _(unverified)_, the server could remember the project and branch the first
   `brief` call names for that `Mcp-Session-Id` and accept a hook's commit-only checkpoint
   (branch and hash parsed from `${tool_response.stdout}`). Still depends on the first
   `brief` call, and makes the stateless server keep per-session state.

Rejected: reading Claude Code's stored MCP OAuth token from a hook. The storage is
undocumented, the access token lasts 15 minutes and is refreshed only when Claude Code uses
the connection, and pulling tokens out of a credential store is exactly what an agent
sandbox should not do.
