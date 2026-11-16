#!/bin/sh
# Shared helpers for the Satchel hooks. Sourced, never run. POSIX sh + git only; no network.
# The hooks never call the server: the MCP connection holds the OAuth login, so they tell
# the model what to call (and fill-arguments.sh fills in the git-derived arguments).
# Hooks that read or write JSON beyond one field need jq and do nothing without it.

# Hooks stay silent unless the plugin is configured.
satchel_enabled() {
  [ -n "${SATCHEL_URL:-}" ]
}

# A top-level string field of the hook's stdin JSON, read with a minimal sed. Prints nothing
# when the field is absent or odd (escaped characters).
satchel_input_field() { # json key
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\)\".*/\1/p" | head -n 1
}

# The "cwd" field; callers fall back through satchel_dir.
satchel_input_cwd() { # json
  satchel_input_field "$1" cwd
}

# Directory the hook should look at: the first argument, else Claude's project dir, else $PWD.
satchel_dir() {
  for d in "$1" "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
    if [ -n "$d" ] && [ -d "$d" ]; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

# The context: the project id, origin remote reduced to host/owner/repo, lower-cased, without
# .git; the directory name when there is no remote.
satchel_context() { # dir
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

# The thread: the current branch; prints nothing on a detached HEAD or outside a repository.
satchel_thread() { # dir
  git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null
}

# Short HEAD commit; prints nothing outside a repository or before the first commit.
satchel_head() { # dir
  git -C "$1" rev-parse --short --verify --quiet 'HEAD^{commit}' 2>/dev/null
}

# This machine's name for host-scoped memories: the short hostname, lower-cased.
satchel_host() {
  uname -n 2>/dev/null | cut -d. -f1 | tr '[:upper:]' '[:lower:]'
}

# Escape a string for a JSON value (backslash, double quote; control characters dropped).
satchel_json_escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ---- what the work is ------------------------------------------------------------------

# Extensions that mean code is being written. Anything else (md, json, yaml) is a file type
# but not code, so it does not bring in the `code` tag.
SATCHEL_CODE_EXTENSIONS=" ts tsx mts cts js jsx mjs cjs svelte vue astro py rb go rs java kt kts swift c h cc cpp cxx hpp cs fs php sh bash zsh fish lua pl scala ex exs erl hs ml clj cljs dart r jl zig nim sql "

# Files that say nothing about the work: images, fonts, lockfiles, generated maps.
SATCHEL_NOISE_EXTENSIONS=" png jpg jpeg gif webp ico svg pdf woff woff2 ttf otf eot lock map gz zip tgz snap "

satchel_is_code_ext() { # ext
  case "$SATCHEL_CODE_EXTENSIONS" in *" $1 "*) return 0 ;; esac
  return 1
}

# The lower-cased extension of a path, or nothing.
satchel_ext() { # path
  base=$(basename "$1")
  case "$base" in
    *.*) printf '%s\n' "${base##*.}" | tr '[:upper:]' '[:lower:]' ;;
  esac
}

# The repository's main file types, one per line, most common first: at most 6, each at least
# 3% of the tracked files (and at least 2 files). Nothing outside a git repository.
satchel_filetypes() { # dir
  git -C "$1" ls-files 2>/dev/null |
    sed -n 's/.*\.\([A-Za-z0-9]\{1,16\}\)$/\1/p' | tr '[:upper:]' '[:lower:]' |
    awk -v noise="$SATCHEL_NOISE_EXTENSIONS" '
      BEGIN { n = split(noise, words, " "); for (i = 1; i <= n; i++) skip[words[i]] = 1 }
      !($0 in skip) { count[$0]++; total++ }
      END { for (ext in count) if (count[ext] >= 2 && count[ext] * 100 >= total * 3) print count[ext], ext }
    ' | sort -rn | head -n 6 | awk '{ print $2 }'
}

# A dependency name as a tag: lower-case kebab, scope folded in (@sveltejs/kit -> sveltejs-kit).
satchel_tag_of() { # name
  printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]' |
    sed -e 's/^@//' -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//'
}

# A scoped package also gives its bare name (@biomejs/biome -> biomejs-biome and biome), since
# memories are tagged by what people call the library.
satchel_tags_of_package() { # name
  satchel_tag_of "$1"
  case "$1" in @*/*) satchel_tag_of "${1#*/}" ;; esac
}

# Top-level dependency names as tags, one per line (package.json needs jq; requirements.txt not).
satchel_dependency_tags() { # dir
  {
    if [ -f "$1/package.json" ] && command -v jq >/dev/null 2>&1; then
      jq -r '[.dependencies, .devDependencies, .peerDependencies] | map(keys? // []) | add // [] | .[]' \
        "$1/package.json" 2>/dev/null
    fi
    if [ -f "$1/requirements.txt" ]; then
      sed -n 's/^[[:space:]]*\([A-Za-z0-9][A-Za-z0-9._-]*\).*/\1/p' "$1/requirements.txt"
    fi
  } | grep -v '^@types/' | while IFS= read -r name; do satchel_tags_of_package "$name"; done |
    awk 'NF && !seen[$0]++' | head -n 60
}

# Tags describing the work: `code` when a main file type is code, then dependency tags.
satchel_work_tags() { # dir filetypes(newline-separated)
  for ext in $2; do
    if satchel_is_code_ext "$ext"; then
      printf 'code\n'
      break
    fi
  done
  satchel_dependency_tags "$1"
}

# Newline-separated values as a JSON array of strings (values are already safe labels).
satchel_json_array() { # lines
  printf '%s\n' "$1" | awk 'NF { printf "%s\"%s\"", (n++ ? "," : "["), $0 } END { printf "%s", (n ? "]" : "[]") }'
}

# ---- per-session state ----------------------------------------------------------------

# Where the hooks remember, per session, which labels exist and which each agent has loaded.
satchel_state_dir() { # session_id
  root=${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}/satchel-plugin}
  session=$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_')
  [ -n "$session" ] || session=unknown
  dir="$root/state/$session"
  mkdir -p "$dir" 2>/dev/null || return 1
  printf '%s\n' "$dir"
}

# The agent a hook runs for: its agent_id inside a subagent, else "main". Safe as a filename.
satchel_agent() { # json
  agent=$(satchel_input_field "$1" agent_id | tr -c 'A-Za-z0-9_-' '_')
  printf '%s\n' "${agent:-main}"
}
