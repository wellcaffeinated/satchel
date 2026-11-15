#!/bin/sh
# PreToolUse hook on Write, Edit, MultiEdit and NotebookEdit: before an agent's first edit of
# a file type whose rules it has not loaded, refuses the edit once, saying which `recall`
# loads them. The retry goes through whatever happened, so an agent without the Satchel
# tools loses one turn, not the edit. "Rules exist" comes from the labels lines of the last
# brief (labels-seen.sh); with no brief seen, code files ask for the code rules. Needs jq.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

satchel_enabled || exit 0
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -n "$path" ] || exit 0
ext=$(satchel_ext "$path")
[ -n "$ext" ] || exit 0
state=$(satchel_state_dir "$(satchel_input_field "$input" session_id)") || exit 0
agent=$(satchel_agent "$input")
known="$state/known"
loaded="$state/$agent.loaded"
asked="$state/$agent.asked"

has() { # file line
  [ -f "$1" ] && grep -qxF "$2" "$1"
}

# The labels this edit needs: the file type when it has rules, `code` for code files.
needed() {
  if [ -f "$known" ]; then
    if has "$known" "filetype:$ext"; then printf 'filetype:%s\n' "$ext"; fi
    if satchel_is_code_ext "$ext" && has "$known" 'tag:code'; then printf 'tag:code\n'; fi
  elif satchel_is_code_ext "$ext"; then
    printf 'filetype:%s\ntag:code\n' "$ext"
  fi
}

missing=$(needed | while IFS= read -r label; do has "$loaded" "$label" || printf '%s\n' "$label"; done)
[ -n "$missing" ] || exit 0
! has "$asked" "$ext" || exit 0
printf '%s\n' "$ext" >>"$asked"

# Tags for the recall: `code` when it is missing, plus dependency tags that have rules.
dir=$(satchel_dir "$(satchel_input_cwd "$input")") || dir=""
dependency_tags=$(if [ -n "$dir" ] && [ -f "$known" ]; then
  satchel_dependency_tags "$dir" | while IFS= read -r tag; do
    if has "$known" "tag:$tag" && ! has "$loaded" "tag:$tag"; then printf '%s\n' "$tag"; fi
  done
fi)
tags=$( {
  printf '%s\n' "$missing" | sed -n 's/^tag://p'
  printf '%s\n' "$dependency_tags"
} | awk 'NF && !seen[$0]++')
recall="filetypes=[\"$ext\"]"
if [ -n "$tags" ]; then recall="$recall, tags=$(satchel_json_array "$tags")"; fi

reason="Satchel has rules for .$ext files that you have not loaded in this session. Before this edit, call the Satchel \`recall\` tool with $recall and read every page, then make the edit again. (Asked once per file type.)"
jq -nc --arg reason "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse",
  permissionDecision: "deny", permissionDecisionReason: $reason}}'
exit 0
