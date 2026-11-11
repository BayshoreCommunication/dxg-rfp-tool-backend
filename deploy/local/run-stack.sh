#!/usr/bin/env bash
# Runs the whole app against the local Docker stack (deploy/local): backend API, worker and
# dispatcher, the planner dashboard and the admin app. Start the stack first: npm run stack:up.
#
# Ports differ from ../run-all.sh (8100/3100/3101 instead of 8000/3000/3001) so the stack never
# talks to a backend that uses your .env.local. The admin app shares its .next folder with a
# normal `next dev`, so stop run-all.sh's admin before starting this.
set -u

BACKEND_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
DASHBOARD_DIR="${DASHBOARD_DIR:-$WORKSPACE_DIR/dxg-rfp-tool-dashboard}"
ADMIN_DIR="${ADMIN_DIR:-$WORKSPACE_DIR/dxg-rfp-tool-admin}"

# Must match deploy/local/stack.env.
BFF_SECRET="local-stack-bff-shared-secret-32-characters-minimum"
AUTH_SECRET_VALUE="local-stack-auth-secret-32-characters-minimum-xx"

PIDS=""
STOPPING=0

kill_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

stop_services() {
  [ "$STOPPING" -eq 1 ] && return
  STOPPING=1
  trap - INT TERM EXIT
  printf '\nStopping the local stack apps (Docker services keep running; npm run stack:down stops them)...\n'
  # npm -> nodemon -> ts-node is three levels deep, so signal the whole tree, children first.
  for pid in $PIDS; do kill_tree "$pid"; done
  for pid in $PIDS; do wait "$pid" 2>/dev/null || true; done
}

require_project() {
  if [ ! -d "$1/node_modules" ]; then
    printf 'Missing or not installed: %s (run npm install there)\n' "$1" >&2
    exit 1
  fi
}

start_service() {
  name="$1"; dir="$2"; shift 2
  printf 'Starting %-18s %s\n' "$name" "$*"
  ( cd "$dir" && exec "$@" ) &
  PIDS="$PIDS $!"
}

require_project "$BACKEND_DIR"
require_project "$DASHBOARD_DIR"
require_project "$ADMIN_DIR"

if ! docker compose -f "$BACKEND_DIR/deploy/local/docker-compose.yml" ps --status running --services 2>/dev/null | grep -q postgres; then
  printf 'The local stack is not running. Start it with: npm run stack:up\n' >&2
  exit 1
fi

trap stop_services INT TERM EXIT

BACKEND_ENV=(env RFPILOT_ENV_FILE="${RFPILOT_ENV_FILE:-deploy/local/stack.env}")
# Next.js gives real environment variables priority over .env / .env.local, so these win over
# whatever the app's own env files say.
FRONTEND_ENV=(env
  BACKEND_URL=http://localhost:8100
  NEXT_PUBLIC_BACKEND_URL=http://localhost:8100
  NEXT_PUBLIC_API_URL=http://localhost:8100
  BFF_SHARED_SECRET="$BFF_SECRET"
  AUTH_SECRET="$AUTH_SECRET_VALUE"
  NEXTAUTH_SECRET="$AUTH_SECRET_VALUE"
  AUTH_TRUST_HOST=true
  GOOGLE_CLIENT_ID=local-stack-google-client
  GOOGLE_CLIENT_SECRET=local-stack-google-secret
  NEXT_PUBLIC_AI_ASSISTANT_ENABLED=false
  NEXT_PUBLIC_CONVERSATIONS_ENABLED=false
  NEXT_PUBLIC_CONVERSATION_EXTRACTION_ENABLED=false
  NEXT_PUBLIC_VENDOR_ANALYSIS_ENABLED=false)

start_service "backend API" "$BACKEND_DIR" "${BACKEND_ENV[@]}" npm run dev
start_service "backend worker" "$BACKEND_DIR" "${BACKEND_ENV[@]}" npm run dev:worker
start_service "backend dispatcher" "$BACKEND_DIR" "${BACKEND_ENV[@]}" npm run dev:dispatcher
start_service "planner dashboard" "$DASHBOARD_DIR" "${FRONTEND_ENV[@]}" \
  NEXTAUTH_URL=http://localhost:3100 NEXT_PUBLIC_FRONTEND_URL=http://localhost:3100 \
  NEXT_PUBLIC_APP_URL=http://localhost:3100 NEXT_DIST_DIR=.next-stack \
  npm run dev -- --port 3100
start_service "admin application" "$ADMIN_DIR" "${FRONTEND_ENV[@]}" \
  NEXTAUTH_URL=http://localhost:3101 npm run dev -- --port 3101

printf '\nPlanner: http://localhost:3100\nAdmin:   http://localhost:3101\nAPI:     http://localhost:8100\n'
printf 'Email:   http://127.0.0.1:48025\nAccounts: see deploy/local/README.md (password Rfpilot-local-1)\n'
printf 'Press Ctrl+C to stop the apps.\n\n'

while [ "$STOPPING" -eq 0 ]; do
  for pid in $PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"; status=$?
      printf '\nA service exited with status %s; stopping the others.\n' "$status" >&2
      exit "$status"
    fi
  done
  sleep 1
done
