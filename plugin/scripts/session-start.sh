#!/bin/sh
# SessionStart hook: tells the model to call `brief` with this project and branch, and
# gives HEAD so it can judge the checkpoint the brief returns. Local only (git, no network):
# the model's call goes over the OAuth MCP connection, which a hook cannot use at launch.
# Silent (no output, exit 0) when SATCHEL_URL is unset.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

satchel_enabled || exit 0
input=$(cat 2>/dev/null) || input=""
dir=$(satchel_dir "$(satchel_input_cwd "$input")") || exit 0
project=$(satchel_project "$dir")
[ -n "$project" ] || exit 0
branch=$(satchel_branch "$dir")
head=$(satchel_head "$dir")
host=$(satchel_host)

# The backticks are literal Markdown for the model.
# shellcheck disable=SC2016
if [ -n "$branch" ]; then
  printf 'Satchel memory: before other work, call the Satchel `brief` tool with project=%s and branch=%s.\n' "$project" "$branch"
elif git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'Satchel memory: before other work, call the Satchel `brief` tool with project=%s (detached HEAD, so no branch).\n' "$project"
else
  printf 'Satchel memory: before other work, call the Satchel `brief` tool (project=%s, not a git repository).\n' "$project"
fi
if [ -n "$head" ]; then
  printf 'HEAD is %s. A checkpoint in the brief is a claim about the past: compare its commit with HEAD (git log) before relying on it.\n' "$head"
fi
if [ -n "$host" ]; then
  # shellcheck disable=SC2016
  printf 'This machine is %s: pass host=%s to `brief` and `recall`. Save a memory with scope `host` only when it is true of this machine alone (its setup, paths, services); preferences and general facts stay global.\n' "$host" "$host"
fi
exit 0
