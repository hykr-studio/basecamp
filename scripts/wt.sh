#!/usr/bin/env bash
# Parallel worktrees for large multi-agent builds: one git worktree, one database and one .env
# per unit of work, sharing the Postgres/Redis/Mailpit of `pnpm infra:up` (Compose project
# "basecamp"). Each worktree's database is created from the template database `app_tpl`,
# which is the integration branch's schema, migrated from scratch.
#
#   scripts/wt.sh init <id>          worktree ../basecamp-wt/<id> on branch gap/<id>, database
#                                    app_<id> from app_tpl, .env, pnpm install, server build
#   scripts/wt.sh resetdb <id>       drop and recreate app_<id> from app_tpl
#   scripts/wt.sh test <id> [args]   pnpm turbo run test in the worktree, at most 2 at a time
#   scripts/wt.sh check <id>         fail if the branch commits generated drizzle migrations
#   scripts/wt.sh tpl                rebuild app_tpl from the main checkout's migrations
#   scripts/wt.sh ci [--since <sha>|--full]   the CI sequence in the main checkout, fresh DB
#   scripts/wt.sh rm <id>            remove the worktree and its database (keeps the branch)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WTROOT="${WTROOT:-$(dirname "$ROOT")/basecamp-wt}"
BASE="${BASE_BRANCH:-feat/platform-gaps}"
LOCKS="${WT_LOCKS:-$WTROOT/.locks}"
export TURBO_CACHE_DIR="${TURBO_CACHE_DIR:-$WTROOT/.turbo-cache}"

psql_() { docker exec -i basecamp-postgres-1 psql -U app -d "${2:-postgres}" -v ON_ERROR_STOP=1 -qtAc "$1"; }
dbname() { echo "app_$(echo "$1" | tr '[:upper:]-.' '[:lower:]__')"; }
wtdir() { echo "$WTROOT/$1"; }

need() { [ -n "${1:-}" ] || { echo "usage: wt.sh $cmd <id>" >&2; exit 2; }; }

createdb_from_tpl() {
  local d="$1"
  psql_ "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('app_tpl', '$d') AND pid <> pg_backend_pid()" >/dev/null
  psql_ "DROP DATABASE IF EXISTS $d WITH (FORCE)"
  psql_ "CREATE DATABASE $d TEMPLATE app_tpl"
}

write_env() {
  local wt="$1" d="$2"
  sed -E "s#^(DATABASE_URL|MIGRATE_DATABASE_URL)=(postgres://[^/]+)/app[[:space:]]*\$#\1=\2/$d#" "$ROOT/.env" \
    | grep -vE '^(BULL_PREFIX|WHALOC_TEST_URL)=' >"$wt/.env"
  {
    echo "BULL_PREFIX=$d"
    # Golden WhatsApp conversations run only in the main checkout (whaloc-test posts webhooks to
    # one fixed port); an unreachable URL makes them skip here.
    echo "WHALOC_TEST_URL=http://127.0.0.1:9"
  } >>"$wt/.env"
}

cmd="${1:-}"
case "$cmd" in
  init)
    id="${2:-}"; need "$id"; wt="$(wtdir "$id")"; d="$(dbname "$id")"
    mkdir -p "$WTROOT" "$LOCKS" "$TURBO_CACHE_DIR"
    if [ ! -d "$wt" ]; then
      if git -C "$ROOT" show-ref --verify --quiet "refs/heads/gap/$id"; then
        git -C "$ROOT" worktree add -q "$wt" "gap/$id"
      else
        git -C "$ROOT" worktree add -q -b "gap/$id" "$wt" "$BASE"
      fi
    fi
    createdb_from_tpl "$d"
    write_env "$wt" "$d"
    (cd "$wt" && pnpm install --prefer-offline >/dev/null 2>&1 || pnpm install)
    (cd "$wt" && pnpm turbo run build --concurrency=3 \
      --filter='!@application/mobile' --filter='!@application/back-office' >/dev/null) \
      || echo "warning: initial build failed in $wt; run pnpm build there to see why" >&2
    echo "worktree=$wt branch=gap/$id database=$d"
    ;;
  resetdb)
    id="${2:-}"; need "$id"; createdb_from_tpl "$(dbname "$id")"; echo "reset $(dbname "$id")"
    ;;
  test)
    id="${2:-}"; need "$id"; shift 2; wt="$(wtdir "$id")"; mkdir -p "$LOCKS"
    # A two-slot semaphore: e2e suites boot the API against Postgres and Redis; more than two at
    # once starves the machine.
    slot=""
    while [ -z "$slot" ]; do
      for n in 1 2; do
        if mkdir "$LOCKS/test.$n" 2>/dev/null; then slot="$LOCKS/test.$n"; break; fi
      done
      [ -n "$slot" ] || sleep 5
    done
    trap 'rmdir "$slot" 2>/dev/null || true' EXIT
    # Export the worktree's .env: Vitest's globalSetup (which migrates the fixture) runs in the
    # main process and does not see the config's test.env, so it would migrate the default DB.
    (cd "$wt" && set -a && . ./.env && set +a && pnpm turbo run test --concurrency=1 "$@")
    ;;
  check)
    id="${2:-}"; need "$id"; wt="$(wtdir "$id")"
    changed="$(git -C "$wt" diff --name-only "$BASE"...HEAD -- \
      'framework/db/drizzle' 'application/domain/drizzle' || true)"
    if [ -n "$changed" ]; then
      echo "Generated migrations must not be committed (the integrator generates them):" >&2
      echo "$changed" >&2
      exit 1
    fi
    echo "ok: no generated migrations on gap/$id"
    ;;
  tpl)
    psql_ "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app_tpl' AND pid <> pg_backend_pid()" >/dev/null
    psql_ "DROP DATABASE IF EXISTS app_tpl WITH (FORCE)"
    psql_ "CREATE DATABASE app_tpl"
    psql_ "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pgcrypto;" app_tpl
    (cd "$ROOT" && DATABASE_URL=postgres://app:app@localhost:5432/app_tpl \
      MIGRATE_DATABASE_URL=postgres://app:app@localhost:5432/app_tpl pnpm db:migrate >/dev/null)
    echo "app_tpl rebuilt from $(git -C "$ROOT" rev-parse --short HEAD)"
    ;;
  ci)
    # The CI sequence of .github/workflows/ci.yml in the main checkout, on a database migrated
    # from scratch (app_ci). Tests: only what changed since --since <sha>, or everything (--full).
    shift; since=""; full=0
    while [ $# -gt 0 ]; do
      case "$1" in --since) since="$2"; shift 2 ;; --full) full=1; shift ;; *) shift ;; esac
    done
    cd "$ROOT"
    psql_ "DROP DATABASE IF EXISTS app_ci WITH (FORCE)"
    psql_ "CREATE DATABASE app_ci"
    psql_ "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pgcrypto;" app_ci
    set -a; . ./.env; set +a
    export DATABASE_URL=postgres://app:app@localhost:5432/app_ci
    export MIGRATE_DATABASE_URL="$DATABASE_URL" BULL_PREFIX=app_ci
    step() { local name="$1"; shift; echo "::step $name"; "$@" || { echo "::fail $name"; exit 1; }; }
    step install pnpm install --frozen-lockfile
    step lint pnpm lint
    step build pnpm build
    step typecheck pnpm typecheck
    step lint:deps pnpm lint:deps
    step migrate pnpm db:migrate
    if [ "$full" = 1 ] || [ -z "$since" ]; then
      step test pnpm turbo run test --force
    else
      step test pnpm turbo run test --force --filter="...[$since]"
    fi
    echo "::ok ci passed at $(git rev-parse --short HEAD)"
    ;;
  rm)
    id="${2:-}"; need "$id"
    git -C "$ROOT" worktree remove --force "$(wtdir "$id")" 2>/dev/null || true
    psql_ "DROP DATABASE IF EXISTS $(dbname "$id") WITH (FORCE)"
    echo "removed worktree and database for $id"
    ;;
  *)
    sed -n '2,16p' "$0"; exit 2
    ;;
esac
