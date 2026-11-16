#!/bin/sh
# SessionStart hook: tells the model to call `brief` with this context, thread, host and the
# work this repository involves (file types, the `code` tag, dependency tags), so the rules
# for that work load with the brief. Gives HEAD so it can judge the checkpoint the brief
# returns. Local only (git, no network): the model's call goes over the OAuth MCP connection.
# Also runs after compaction and /clear, which drop what was loaded, so it forgets what the
# main agent had loaded. Silent (no output, exit 0) when SATCHEL_URL is unset.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

satchel_enabled || exit 0
input=$(cat 2>/dev/null) || input=""
dir=$(satchel_dir "$(satchel_input_cwd "$input")") || exit 0
context=$(satchel_context "$dir")
[ -n "$context" ] || exit 0
thread=$(satchel_thread "$dir")
head=$(satchel_head "$dir")
host=$(satchel_host)
filetypes=$(satchel_filetypes "$dir")
tags=$(satchel_work_tags "$dir" "$filetypes")

forget_main_agent_state() {
  state=$(satchel_state_dir "$(satchel_input_field "$input" session_id)") || return 0
  rm -f "$state/main.loaded" "$state/main.asked"
}
forget_main_agent_state

# Comma-separated, at most 12 values, for reading; the PreToolUse hook passes the full lists.
listed() {
  printf '%s\n' "$1" | awk 'NF { if (n < 12) printf "%s%s", (n ? ", " : ""), $0; n++ } END { if (n > 12) printf ", ..." }'
}

# The backticks are literal Markdown for the model.
# shellcheck disable=SC2016
if [ -n "$thread" ]; then
  printf 'Satchel memory: before other work, call the Satchel `brief` tool with context=%s and thread=%s.\n' "$context" "$thread"
elif git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'Satchel memory: before other work, call the Satchel `brief` tool with context=%s (detached HEAD, so no thread).\n' "$context"
else
  printf 'Satchel memory: before other work, call the Satchel `brief` tool (context=%s, not a git repository).\n' "$context"
fi
if [ -n "$filetypes" ] || [ -n "$tags" ]; then
  # shellcheck disable=SC2016
  printf 'This work involves filetypes [%s] and tags [%s]: pass them to `brief` so the rules for this work load with it (they are filled in for you when left out).\n' "$(listed "$filetypes")" "$(listed "$tags")"
fi
if [ -n "$head" ]; then
  printf 'HEAD is %s. A checkpoint in the brief is a claim about the past: compare its commit with HEAD (git log) before relying on it.\n' "$head"
fi
if [ -n "$host" ]; then
  # shellcheck disable=SC2016
  printf 'This machine is %s: pass host=%s to `brief` and `recall`. Save a memory with scope `host` only when it is true of this machine alone (its setup, paths, services); preferences and general facts stay global.\n' "$host" "$host"
fi
exit 0
