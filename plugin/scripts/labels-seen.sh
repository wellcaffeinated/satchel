#!/bin/sh
# PostToolUse hook on the Satchel `brief` tool: records which file types and tags have
# memories, from the brief's "Tags: ..." and "File types: ..." lines (docs/design.md, "Lines
# clients may parse"). The first-edit check only asks for rules that exist. Needs jq.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
state=$(satchel_state_dir "$(satchel_input_field "$input" session_id)") || exit 0

# Every string in the tool's response, whatever shape the client gives it.
text=$(printf '%s' "$input" | jq -r '[.tool_response | .. | strings] | join("\n")' 2>/dev/null) ||
  exit 0

# `Tags: code (12), rxjs (3)` -> tag:code, tag:rxjs
labels_of() { # line-prefix kind
  printf '%s\n' "$text" | sed -n "s/^$1: //p" | head -n 1 | tr ',' '\n' |
    sed -n "s/^ *\([a-z0-9][a-z0-9-]*\) ([0-9][0-9]*)\$/$2:\1/p"
}

{
  labels_of 'Tags' tag
  labels_of 'File types' filetype
} >"$state/known.tmp" && mv "$state/known.tmp" "$state/known"
exit 0
