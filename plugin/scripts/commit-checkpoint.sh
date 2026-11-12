#!/bin/sh
# PostToolUse hook (Bash, git commit): records a hash-only checkpoint (project, branch,
# commit; no summary) with POST /api/checkpoint. The server keeps any existing summary.
# Runs async. Silent and exit 0 on any failure. Skips detached HEAD (no branch to record).

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

base=$(satchel_base) || exit 0

# The commit may have been made in a directory other than the project root (a worktree,
# a cd), so prefer the "cwd" field of the hook's stdin JSON. This is the one place a
# field is read from stdin, with a minimal sed; it is validated as an existing directory
# and falls back to CLAUDE_PROJECT_DIR / $PWD when absent or odd (backslashes, etc.).
input=$(cat 2>/dev/null) || input=""
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' | head -n 1)
dir=$(satchel_dir "$cwd") || exit 0

branch=$(satchel_branch "$dir")
[ -n "$branch" ] || exit 0
commit=$(git -C "$dir" rev-parse --short 'HEAD^{commit}' 2>/dev/null) || exit 0
[ -n "$commit" ] || exit 0
project=$(satchel_project "$dir")
[ -n "$project" ] || exit 0

body=$(printf '{"project":"%s","branch":"%s","commit":"%s"}' \
  "$(satchel_json_escape "$project")" "$(satchel_json_escape "$branch")" "$commit")

printf '%s' "$body" | satchel_curl --output /dev/null -X POST \
  -H 'Content-Type: application/json' --data-binary @- "$base/api/checkpoint" || true
exit 0
