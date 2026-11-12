#!/bin/sh
# MCP headersHelper: prints a JSON object of auth headers chosen from the environment.
#   SATCHEL_TOKEN                          -> Authorization: Bearer <token>
#   SATCHEL_CF_CLIENT_ID + _CLIENT_SECRET  -> CF-Access-Client-Id / CF-Access-Client-Secret
# With none of these set it prints {} so Claude Code falls back to interactive OAuth.
# A value containing a quote, backslash or control character is skipped, so the JSON
# below is always well formed.

safe() {
  case "$1" in
    '') return 1 ;;
    *[!\ -~]*) return 1 ;; # anything outside printable ASCII
    *\"* | *\\*) return 1 ;;
  esac
  return 0
}

out=""
add() { # name value
  if [ -n "$out" ]; then out="$out, "; fi
  out="$out\"$1\": \"$2\""
}

if safe "${SATCHEL_TOKEN:-}"; then
  add "Authorization" "Bearer $SATCHEL_TOKEN"
fi
if safe "${SATCHEL_CF_CLIENT_ID:-}" && safe "${SATCHEL_CF_CLIENT_SECRET:-}"; then
  add "CF-Access-Client-Id" "$SATCHEL_CF_CLIENT_ID"
  add "CF-Access-Client-Secret" "$SATCHEL_CF_CLIENT_SECRET"
fi

printf '{%s}\n' "$out"
