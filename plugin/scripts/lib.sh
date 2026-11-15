#!/bin/sh
# Shared helpers for the Satchel hooks. Sourced, never run. POSIX sh + git only; no network.
# The hooks never call the server: the MCP connection holds the OAuth login, so they tell
# the model what to call (and fill-arguments.sh fills in the git-derived arguments).

# Hooks stay silent unless the plugin is configured.
satchel_enabled() {
  [ -n "${SATCHEL_URL:-}" ]
}

# The "cwd" field of the hook's stdin JSON, read with a minimal sed. Prints nothing when the
# field is absent or odd (escaped characters); callers fall back through satchel_dir.
satchel_input_cwd() { # json
  printf '%s' "$1" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' | head -n 1
}

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

# Short HEAD commit; prints nothing outside a repository or before the first commit.
satchel_head() { # dir
  git -C "$1" rev-parse --short --verify --quiet 'HEAD^{commit}' 2>/dev/null
}

# Escape a string for a JSON value (backslash, double quote; control characters dropped).
satchel_json_escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
