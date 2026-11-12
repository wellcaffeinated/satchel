#!/bin/sh
# SessionStart hook: prints the Satchel brief for this project and branch as context.
# Silent (no output, exit 0) when SATCHEL_URL is unset or the server does not answer;
# worst case it adds about 3 seconds (curl --max-time) to session start.

dir_of_this_script=$(dirname "$0")
# shellcheck source=lib.sh
# shellcheck source-path=SCRIPTDIR
. "$dir_of_this_script/lib.sh" || exit 0

base=$(satchel_base) || exit 0
dir=$(satchel_dir "") || exit 0
project=$(satchel_project "$dir")
branch=$(satchel_branch "$dir")
[ -n "$project" ] || exit 0

if [ -n "$branch" ]; then
  brief=$(satchel_curl --get --data-urlencode "project=$project" \
    --data-urlencode "branch=$branch" "$base/api/brief") || exit 0
else
  brief=$(satchel_curl --get --data-urlencode "project=$project" \
    "$base/api/brief") || exit 0
fi
[ -n "$brief" ] || exit 0

printf '%s\n' "$brief"

# Compare the branch checkpoint's commit with this working tree. Only meaningful on a
# named branch, where the brief carries exactly one checkpoint.
# Depends on the server writing a line "checkpoint-commit: <hash>".
[ -n "$branch" ] || exit 0
hash=$(printf '%s\n' "$brief" | sed -n 's/^checkpoint-commit:[[:space:]]*\([0-9A-Fa-f]\{4,40\}\)[[:space:]]*$/\1/p' | head -n 1)
[ -n "$hash" ] || exit 0
git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0

head_full=$(git -C "$dir" rev-parse --verify --quiet 'HEAD^{commit}') || head_full=""
cp_full=$(git -C "$dir" rev-parse --verify --quiet "$hash^{commit}") || cp_full=""

if [ -z "$cp_full" ]; then
  printf "Checkpoint commit %s is not in this repository's history\n" "$hash"
elif [ -z "$head_full" ]; then
  exit 0
elif [ "$cp_full" = "$head_full" ]; then
  printf 'Checkpoint commit %s matches HEAD\n' "$hash"
elif git -C "$dir" merge-base --is-ancestor "$cp_full" "$head_full" 2>/dev/null; then
  n=$(git -C "$dir" rev-list --count "$cp_full..$head_full" 2>/dev/null) || exit 0
  if [ "$n" = 1 ]; then unit=commit; else unit=commits; fi
  printf 'Checkpoint commit %s is %s %s behind HEAD\n' "$hash" "$n" "$unit"
elif git -C "$dir" merge-base --is-ancestor "$head_full" "$cp_full" 2>/dev/null; then
  n=$(git -C "$dir" rev-list --count "$head_full..$cp_full" 2>/dev/null) || exit 0
  if [ "$n" = 1 ]; then unit=commit; else unit=commits; fi
  printf 'Checkpoint commit %s is %s %s ahead of HEAD\n' "$hash" "$n" "$unit"
else
  printf 'Checkpoint commit %s is on a different line of history than HEAD\n' "$hash"
fi
exit 0
