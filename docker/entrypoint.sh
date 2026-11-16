#!/bin/sh
# Container entrypoint, following LinuxServer.io conventions: PUID and PGID choose the user
# that owns the files, UMASK their mode. Started as root, it gives the `node` user those ids,
# makes the data and model directories theirs, and runs the server as that user.
# Started with --user instead, it runs the server as given and touches nothing.
set -eu

umask "${UMASK:-022}"

is_number() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Make a directory owned by PUID:PGID. Recursive only when the top is wrong (PUID changed,
# or a fresh bind mount), so an ordinary restart does not walk the whole tree.
own_directory() {
  mkdir -p "$1"
  if [ "$(stat -c %u:%g "$1")" != "$PUID:$PGID" ]; then
    echo "satchel: giving $1 to $PUID:$PGID" >&2
    chown -R "$PUID:$PGID" "$1"
  fi
}

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if ! is_number "$PUID" || ! is_number "$PGID"; then
  echo "satchel: PUID and PGID must be numeric ids, got PUID=$PUID PGID=$PGID" >&2
  exit 1
fi

# -o: the ids may already belong to another account in the image (PGID=100 is "users").
if [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
fi
if [ "$(id -u node)" != "$PUID" ]; then
  usermod -o -u "$PUID" node
fi

own_directory "$SATCHEL_DATA"
own_directory "$SATCHEL_MODELS"

# setpriv keeps the environment; HOME must point somewhere the user can read, or git warns
# about /root on every call.
export HOME=/home/node
exec setpriv --reuid=node --regid=node --init-groups "$@"
