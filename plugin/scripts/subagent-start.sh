#!/bin/sh
# SubagentStart hook: tells a subagent that Satchel is there and where it is working. It does
# not load rules up front (most subagents only read); the first-edit check asks a subagent
# that edits code to load the rules for that file type. Silent when SATCHEL_URL is unset.

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
host=$(satchel_host)

where="project=$project"
if [ -n "$branch" ]; then where="$where, branch=$branch"; fi
if [ -n "$host" ]; then where="$where, host=$host"; fi
message="Satchel, the user's long-term memory, is available through its MCP tools. You are working in $where. If your task depends on the user's preferences, conventions or project history, call \`brief\` with those values first, and \`recall\` before work that matches a topic. Before your first edit of a code file you will be asked to load the coding rules for it."

printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' \
  "$(satchel_json_escape "$message")"
exit 0
