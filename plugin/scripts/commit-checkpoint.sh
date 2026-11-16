#!/bin/sh
# PostToolUse hook (Bash, git commands): after a `git commit`, asks the model to record a
# hash-only checkpoint (context = project id, thread = branch, commit; no summary, so the
# server keeps the stored one). The hook cannot call the server itself: the MCP connection
# holds the OAuth login. Needs jq.
#
# The hooks.json `if` filter is only a first pass: Claude Code also runs the hook for
# commands it cannot analyse (a `~` in an assignment, `${VAR:-x}`), so the command is
# checked here. The hook's "cwd" is the session's directory, not one the command `cd`s
# into, so the repository is worked out from the command's `cd` and `git -C` arguments.
# Paths built from shell variables cannot be resolved; such commits are left to the agent's
# own checkpoint at the end of work. Skips detached HEAD, commits that did not happen
# (HEAD older than COMMIT_FRESH_SECONDS) and commits already asked about this session.

COMMIT_FRESH_SECONDS=$((60 * 10))

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

# The directory of the last `git commit` in a shell command, following `cd <dir>` and
# `git -C <dir>` from the starting directory. Prints nothing when the command has no commit.
# Splits on && || ; | & and newlines and on blanks, so quoted arguments with spaces in them
# are not understood; they only matter in paths, and then git finds no repository.
commit_dir_of() { # command start_dir
  COMMAND="$1" START_DIR="$2" awk '
    function unquote(word) {
      gsub(/^["\047]|["\047]$/, "", word)
      return word
    }
    function resolve(base, path) {
      path = unquote(path)
      if (path == "~") return home
      if (substr(path, 1, 2) == "~/") return home substr(path, 2)
      if (substr(path, 1, 1) == "/") return path
      return base "/" path
    }
    function first_word_after_assignments(words, count,    k) {
      k = 1
      while (k <= count && words[k] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) k += 1
      return k
    }
    # The directory a git invocation runs in, or "" when its subcommand is not commit.
    function git_commit_dir(words, count, k, base,    dir) {
      dir = base
      k += 1
      while (k <= count && substr(words[k], 1, 1) == "-") {
        if (words[k] == "-C") dir = resolve(dir, words[k + 1])
        k += (words[k] == "-C" || words[k] == "-c") ? 2 : 1
      }
      return (k <= count && words[k] == "commit") ? dir : ""
    }
    BEGIN {
      home = ENVIRON["HOME"]
      dir = ENVIRON["START_DIR"]
      found = ""
      segments_text = ENVIRON["COMMAND"]
      gsub(/&&|\|\||[;|&\n]/, "\n", segments_text)
      segment_count = split(segments_text, segments, "\n")
      for (s = 1; s <= segment_count; s += 1) {
        segment = segments[s]
        sub(/^[ \t({]+/, "", segment)
        count = split(segment, words, /[ \t]+/)
        k = first_word_after_assignments(words, count)
        if (words[k] == "cd") dir = (k < count) ? resolve(dir, words[k + 1]) : home
        if (words[k] == "git") {
          commit_dir = git_commit_dir(words, count, k, dir)
          if (commit_dir != "") found = commit_dir
        }
      }
      if (found != "") print found
    }
  '
}

# True when HEAD was committed within COMMIT_FRESH_SECONDS: the commit really happened.
head_is_fresh() { # dir
  committed=$(git -C "$1" log -1 --format=%ct 2>/dev/null) || return 1
  [ -n "$committed" ] || return 1
  [ $(($(date +%s) - committed)) -le "$COMMIT_FRESH_SECONDS" ]
}

satchel_enabled || exit 0
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$command" ] || exit 0
start=$(satchel_dir "$(satchel_input_cwd "$input")") || exit 0
dir=$(commit_dir_of "$command" "$start")
[ -n "$dir" ] && [ -d "$dir" ] || exit 0

thread=$(satchel_thread "$dir")
[ -n "$thread" ] || exit 0
commit=$(satchel_head "$dir")
[ -n "$commit" ] || exit 0
head_is_fresh "$dir" || exit 0
context=$(satchel_context "$dir")
[ -n "$context" ] || exit 0

state=$(satchel_state_dir "$(satchel_input_field "$input" session_id)") || exit 0
asked="$state/commits.asked"
asked_line="$context $thread $commit"
if [ -f "$asked" ] && grep -qxF "$asked_line" "$asked"; then exit 0; fi
printf '%s\n' "$asked_line" >>"$asked"

message="Satchel: commit $commit on $thread. Call the Satchel \`checkpoint\` tool now with context=$context, thread=$thread, commit=$commit and no summary (the stored summary is kept; write one only when you stop work on this branch)."
jq -nc --arg message "$message" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $message}}'
exit 0
