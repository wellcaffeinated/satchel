#!/bin/sh
# PreToolUse hook on the Satchel `brief` and `checkpoint` tools: fills project, branch and
# commit from local git when the model left them out, so project names match the hooks'
# exactly. Only fills for the local project; a call naming another project is left alone.
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

# Prints nothing when the input needs no change, so normal permission handling applies.
# A changed input is returned with "allow": in auto mode a rewrite without a decision can
# be denied, and these two tools only read memory or record a checkpoint.
printf '%s' "$input" | jq -c --arg p "$project" --arg b "$branch" --arg c "$commit" '
  .tool_name as $tool
  | .tool_input as $in
  | ($in.project // $p) as $project
  | ($project == $p) as $here
  | ($in.branch // (if $here and $b != "" then $b else null end)) as $branch
  | ($tool | endswith("__checkpoint")) as $isCheckpoint
  | $in
    + {project: $project}
    + (if $branch == null then {} else {branch: $branch} end)
    + (if $isCheckpoint and $in.commit == null and $here and $branch == $b and $c != ""
       then {commit: $c} else {} end)
  | if . == $in then empty
    else {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: .}}
    end' 2>/dev/null
exit 0
