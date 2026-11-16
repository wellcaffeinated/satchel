#!/bin/sh
# PostToolUse hook (Bash, git commit): asks the model to record a hash-only checkpoint
# (context = project id, thread = branch, commit; no summary, so the server keeps the stored
# one). The hook cannot
# call the server itself: the MCP connection holds the OAuth login. Skips detached HEAD.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

satchel_enabled || exit 0
# The commit may have been made outside the project root (a worktree, a cd), so the
# hook's "cwd" field wins over CLAUDE_PROJECT_DIR.
input=$(cat 2>/dev/null) || input=""
dir=$(satchel_dir "$(satchel_input_cwd "$input")") || exit 0

branch=$(satchel_branch "$dir")
[ -n "$branch" ] || exit 0
commit=$(satchel_head "$dir")
[ -n "$commit" ] || exit 0
project=$(satchel_project "$dir")
[ -n "$project" ] || exit 0

message="Satchel: commit $commit on $branch. Call the Satchel \`checkpoint\` tool now with context=$project, thread=$branch, commit=$commit and no summary (the stored summary is kept; write one only when you stop work on this branch)."
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' \
  "$(satchel_json_escape "$message")"
exit 0
