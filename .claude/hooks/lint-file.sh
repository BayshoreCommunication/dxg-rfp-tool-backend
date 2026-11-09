#!/usr/bin/env bash
# PostToolUse (Edit|Write): ESLint errors for the one file Claude just changed.
# Exit 2 sends the errors back to Claude. Also marks the session as having
# touched TypeScript so the Stop hook knows to type-check.
set -u
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')
session=$(printf '%s' "$input" | jq -r '.session_id // "unknown"')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"

[ -n "$file" ] && [ -f "$file" ] || exit 0
case "$file" in
  "$root"/*) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*|*/.next/*|*/dist/*|*/contracts/generated/*) exit 0 ;;
esac

case "$file" in
  *.ts|*.tsx|*.mts|*.cts) touch "${TMPDIR:-/tmp}/claude-tc-${session}-$(basename "$root")" ;;
esac

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts) ;;
  *) exit 0 ;;
esac

cd "$root" || exit 0
out=$(npx --no-install eslint --quiet --no-warn-ignored "$file" 2>&1)
status=$?
if [ $status -eq 1 ]; then
  printf 'ESLint errors in %s (fix before moving on):\n%s\n' "${file#"$root"/}" "$out" | head -40 >&2
  exit 2
fi
exit 0
