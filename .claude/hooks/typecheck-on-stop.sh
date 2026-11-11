#!/usr/bin/env bash
# Stop: if Claude edited TypeScript in this repo during the session, run
# `tsc --noEmit` once before it finishes. Exit 2 hands the errors back so it
# fixes them; a clean run clears the marker. Skips when Claude is already
# continuing because of this hook, so it cannot loop.
set -u
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0
session=$(printf '%s' "$input" | jq -r '.session_id // "unknown"')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
marker="${TMPDIR:-/tmp}/claude-tc-${session}-$(basename "$root")"
[ -f "$marker" ] || exit 0

cd "$root" || exit 0
out=$(npx --no-install tsc --noEmit -p . 2>&1)
if [ $? -ne 0 ]; then
  printf 'Type-check failed (npx tsc --noEmit). Fix these before finishing:\n%s\n' "$out" | head -60 >&2
  exit 2
fi
rm -f "$marker"
exit 0
