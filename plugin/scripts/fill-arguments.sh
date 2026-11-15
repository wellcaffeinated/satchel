#!/bin/sh
# PreToolUse hook on the Satchel `brief`, `recall` and `checkpoint` tools: fills in what
# the model left out, so names match the hooks' exactly.
#   brief:      project, branch, host
#   recall:     host (so this machine's memories rank first and other machines' are hidden)
#   checkpoint: project, branch, commit
# Branch and commit are only filled for the local project; a call naming another project is
# left alone. Never touches `memorize`: tying a memory to a host is the model's decision.
# Needs jq to rewrite the tool input (Claude Code replaces the whole input); without jq it
# does nothing and the call runs as the model wrote it.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
dir=$(satchel_dir "$(satchel_input_cwd "$input")") || exit 0
project=$(satchel_project "$dir")
[ -n "$project" ] || exit 0
branch=$(satchel_branch "$dir")
commit=$(satchel_head "$dir")
host=$(satchel_host)

# Prints nothing when the input needs no change, so normal permission handling applies.
# A changed input is returned with "allow": in auto mode a rewrite without a decision can
# be denied, and these tools only read memory or record a checkpoint.
printf '%s' "$input" | jq -c --arg p "$project" --arg b "$branch" --arg c "$commit" --arg h "$host" '
  .tool_name as $tool
  | .tool_input as $in
  | ($tool | endswith("__brief")) as $isBrief
  | ($tool | endswith("__recall")) as $isRecall
  | ($tool | endswith("__checkpoint")) as $isCheckpoint
  | if ($isBrief or $isRecall or $isCheckpoint) | not then empty else . end
  | ($in.project // (if $isRecall then null else $p end)) as $project
  | ($project == $p) as $here
  | ($in.branch // (if ($isBrief or $isCheckpoint) and $here and $b != "" then $b else null end))
    as $branch
  | $in
    + (if $project == null then {} else {project: $project} end)
    + (if $branch == null then {} else {branch: $branch} end)
    + (if $isCheckpoint and $in.commit == null and $here and $branch == $b and $c != ""
       then {commit: $c} else {} end)
    + (if ($isBrief or $isRecall) and $in.host == null and $h != "" then {host: $h} else {} end)
  | if . == $in then empty
    else {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: .}}
    end' 2>/dev/null
exit 0
