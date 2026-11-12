#!/bin/sh
# Shared helpers for the Satchel hooks. Sourced, never run. POSIX sh + curl + git only.

# Directory the hook should look at: the first argument, else the project dir, else $PWD.
satchel_dir() {
  for d in "$1" "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
    if [ -n "$d" ] && [ -d "$d" ]; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

# project identifier: origin remote reduced to host/owner/repo, lower-cased, without .git;
# the directory name when there is no remote.
satchel_project() { # dir
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || url=""
  if [ -n "$url" ]; then
    printf '%s\n' "$url" | sed \
      -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' \
      -e 's#^[^@/]*@##' \
      -e 's#^\([^/:]*\):[0-9][0-9]*/#\1/#' \
      -e 's#^\([^/:]*\):#\1/#' \
      -e 's#/*$##' \
      -e 's#\.git$##' | tr '[:upper:]' '[:lower:]'
    return 0
  fi
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || top=""
  if [ -z "$top" ]; then top=$(cd "$1" 2>/dev/null && pwd) || top="$1"; fi
  basename "$top"
}

# Current branch name; prints nothing on a detached HEAD or outside a repository.
satchel_branch() { # dir
  git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null
}

# Escape a string for a JSON value (backslash, double quote; control characters dropped).
satchel_json_escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Run curl against Satchel with the configured auth headers and short timeouts.
# usage: satchel_curl <curl args...>   (the URL is given by the caller)
# Auth headers go through a 0600 temp file so tokens never appear in the process list.
# Returns curl's status; prints nothing of its own.
satchel_curl() {
  hdr=$(umask 077 && mktemp 2>/dev/null) || return 1
  {
    printf 'X-Satchel-Client: claude-code-hook\n'
    if [ -n "${SATCHEL_TOKEN:-}" ]; then
      printf 'Authorization: Bearer %s\n' "$SATCHEL_TOKEN"
    fi
    if [ -n "${SATCHEL_CF_CLIENT_ID:-}" ] && [ -n "${SATCHEL_CF_CLIENT_SECRET:-}" ]; then
      printf 'CF-Access-Client-Id: %s\n' "$SATCHEL_CF_CLIENT_ID"
      printf 'CF-Access-Client-Secret: %s\n' "$SATCHEL_CF_CLIENT_SECRET"
    fi
  } >"$hdr"
  curl --silent --fail --connect-timeout 1 --max-time 3 -H "@$hdr" "$@"
  status=$?
  rm -f "$hdr"
  return "$status"
}

# SATCHEL_URL without trailing slashes; fails when unset.
satchel_base() {
  base=${SATCHEL_URL:-}
  [ -n "$base" ] || return 1
  while :; do
    case "$base" in
      */) base=${base%/} ;;
      *) break ;;
    esac
  done
  printf '%s\n' "$base"
}
