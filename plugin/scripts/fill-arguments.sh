#!/bin/sh
# PreToolUse hook on the Satchel `brief`, `recall` and `checkpoint` tools: fills in what
# the model left out, so names match the hooks' exactly.
#   brief:      context (the project id), thread (the branch), host, and for the main agent
#               the work's filetypes and tags (subagents load rules when they first edit,
#               see edit-check.sh)
#   recall:     host (so this machine's memories rank first and other machines' are hidden)
#   checkpoint: context, thread, commit
# Thread and commit are only filled for the local context; a call naming another context
# is left alone. Never touches `memorize` or `save_reference`: tying a memory to a host or to
# some work is the model's decision.
# Also records the filetypes and tags each agent's `brief` and `recall` calls load, for the
# first-edit check. Needs jq (Claude Code replaces the whole input, so it must be merged);
# without jq it does nothing and the call runs as the model wrote it.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
dir=$(satchel_dir "$(satchel_input_cwd "$input")") || exit 0
context=$(satchel_context "$dir")
[ -n "$context" ] || exit 0
thread=$(satchel_thread "$dir")
commit=$(satchel_head "$dir")
host=$(satchel_host)
agent=$(satchel_agent "$input")
filetypes=$(satchel_filetypes "$dir")
tags=$(satchel_work_tags "$dir" "$filetypes")

# {"changed": bool, "input": the tool input to use}, or nothing for tools this is not for.
completed=$(printf '%s' "$input" | jq -c \
  --arg p "$context" --arg b "$thread" --arg c "$commit" --arg h "$host" --arg agent "$agent" \
  --argjson ft "$(satchel_json_array "$filetypes")" --argjson tg "$(satchel_json_array "$tags")" '
  .tool_name as $tool
  | .tool_input as $in
  | ($tool | endswith("__brief")) as $isBrief
  | ($tool | endswith("__recall")) as $isRecall
  | ($tool | endswith("__checkpoint")) as $isCheckpoint
  | if ($isBrief or $isRecall or $isCheckpoint) | not then empty else . end
  | ($in.context // (if $isRecall then null else $p end)) as $context
  | ($context == $p) as $here
  | ($in.thread // (if ($isBrief or $isCheckpoint) and $here and $b != "" then $b else null end))
    as $thread
  | ($isBrief and $agent == "main" and $here and $in.filetypes == null and $in.tags == null)
    as $describeWork
  | $in
    + (if $context == null then {} else {context: $context} end)
    + (if $thread == null then {} else {thread: $thread} end)
    + (if $isCheckpoint and $in.commit == null and $here and $thread == $b and $c != ""
       then {commit: $c} else {} end)
    + (if ($isBrief or $isRecall) and $in.host == null and $h != "" then {host: $h} else {} end)
    + (if $describeWork and ($ft | length) > 0 then {filetypes: $ft} else {} end)
    + (if $describeWork and ($tg | length) > 0 then {tags: $tg} else {} end)
  | {changed: (. != $in), input: ., loads: ($isBrief or $isRecall)}' 2>/dev/null) || exit 0
[ -n "$completed" ] || exit 0

# Remember what this agent is loading, normalised the way the server normalises it.
record_loaded() {
  state=$(satchel_state_dir "$(satchel_input_field "$input" session_id)") || return 0
  printf '%s' "$completed" | jq -r '
    .input
    | ((.filetypes // [])[] | ascii_downcase | sub("^\\."; "") | "filetype:" + .),
      ((.tags // [])[] | ascii_downcase | "tag:" + .)' >>"$state/$agent.loaded" 2>/dev/null
}
if [ "$(printf '%s' "$completed" | jq -r .loads)" = true ]; then record_loaded; fi

# Prints nothing when the input needs no change, so normal permission handling applies.
# A changed input is returned with "allow": in auto mode a rewrite without a decision can
# be denied, and these tools only read memory or record a checkpoint.
[ "$(printf '%s' "$completed" | jq -r .changed)" = true ] || exit 0
printf '%s' "$completed" | jq -c '{hookSpecificOutput: {hookEventName: "PreToolUse",
  permissionDecision: "allow", updatedInput: .input}}'
exit 0
