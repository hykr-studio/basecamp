#!/usr/bin/env bash
# The framework as a user gets it (CI's `consumer` job runs this): every @hykr/* package packed
# as it would be published, a new application scaffolded with the packed create-basecamp and
# installed from those tarballs (no workspace links), then built and typechecked.
#
# With --run, the application then runs: migrated, its API started, and the assistant's evals
# (assistant, voice, WhatsApp) answered by the scripted model. That needs Postgres (with
# framework/cli/infra/postgres/init.sql applied) and Redis, and the environment .env holds
# (DATABASE_URL, REDIS_URL, the secrets). Use a database of its own: it is migrated from scratch.
#
#   scripts/consumer.sh [--run] [--no-build] [<work dir>]
#
# <work dir> (default: a new temporary directory) gets tgz/, cb/ and myapp/, replaced on each
# run. The API listens on PORT (default 3000). Each step prints "::step <name>"; a failure
# prints "::fail <name>" and exits 1; the end prints "::ok".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
run=0
build=1
work=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run) run=1 ;;
    --no-build) build=0 ;;
    -*) sed -n '2,16p' "$0"; exit 2 ;;
    *) work="$1" ;;
  esac
  shift
done
[ -n "$work" ] || work="$(mktemp -d)"
mkdir -p "$work"
work="$(cd "$work" && pwd)"
rm -rf "$work/tgz" "$work/cb" "$work/myapp"
mkdir -p "$work/tgz"
app="$work/myapp"

step() {
  local name="$1"
  shift
  echo "::step $name"
  "$@" || { echo "::fail $name"; exit 1; }
}

pack() {
  for dir in "$ROOT"/framework/*/; do
    (cd "$dir" && pnpm pack --pack-destination "$work/tgz" >/dev/null) || return 1
  done
  ls "$work/tgz"
}

scaffold() {
  mkdir "$work/cb"
  tar xzf "$work"/tgz/hykr-create-basecamp-*.tgz -C "$work/cb"
  (cd "$work" && node cb/package/dist/index.js myapp >/dev/null) || return 1
  # The tarballs stand in for the registry.
  {
    echo
    echo "overrides:"
    for t in "$work"/tgz/hykr-*.tgz; do
      n="$(basename "$t" .tgz | sed 's/^hykr-//; s/-[0-9.]*$//')"
      echo "  \"@hykr/$n\": \"file:$t\""
    done
  } >>"$app/pnpm-workspace.yaml"
}

in_app() { (cd "$app" && "$@"); }

# The API in the background, as one process: its processors inside (WORKER_INLINE), files in
# memory, the scripted model. Stopped when this script exits.
api_pid=""
stop_api() { [ -z "$api_pid" ] || kill "$api_pid" 2>/dev/null || true; }
trap stop_api EXIT
start_api() {
  # exec: the pid is the API's own (the bin shim execs node too), so the trap stops it.
  (cd "$app" && exec ./node_modules/.bin/basecamp start api) >"$work/api.log" 2>&1 &
  api_pid=$!
  for _ in $(seq 1 90); do
    if curl -sf "$API_INTERNAL_URL/health" >/dev/null; then return 0; fi
    kill -0 "$api_pid" 2>/dev/null || break
    sleep 2
  done
  echo "The API did not start at $API_INTERNAL_URL:"
  tail -40 "$work/api.log"
  return 1
}

cd "$ROOT"
if [ "$build" = 1 ]; then step build pnpm turbo run build --filter="./framework/*"; fi
step pack pack
step scaffold scaffold
step install in_app pnpm install
step build-app in_app pnpm -r build
step typecheck-app in_app pnpm -r typecheck
step help in_app pnpm exec basecamp --help

if [ "$run" = 1 ]; then
  export PORT="${PORT:-3000}"
  export BETTER_AUTH_URL="http://localhost:$PORT" API_INTERNAL_URL="http://localhost:$PORT"
  export MODEL_MODE=fake VOICE_MODE=fake WORKER_INLINE=1 STORAGE_DRIVER=memory
  step migrate in_app pnpm exec basecamp db migrate
  step start-api start_api
  step eval in_app pnpm exec basecamp eval
  step eval-voice in_app pnpm exec basecamp eval voice
  step eval-whatsapp in_app pnpm exec basecamp eval whatsapp
fi
echo "::ok consumer passed in $app"
