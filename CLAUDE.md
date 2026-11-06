# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Basecamp is a framework for full-stack apps where an AI assistant works alongside people under the same rules,
approvals and audit trail. You declare an entity once (a Zod spec), and the framework generates the REST
routes, the agent tools, the app data hooks, approval cards, history, and the WhatsApp and voice rendering.
It is a pnpm + Turborepo monorepo. `framework/` holds the `@hykr/*` packages, which can be published to npm.
`application/` holds one sample application built on them: meetings, notes and to-dos.

The long-form references are `docs/developer-guide.md` (architecture, rules, testing, known gaps),
`docs/tutorial.md` (one feature end to end), `docs/new-application.md` (a new product from scratch) and
`DOMAIN.md` (what each application layer must export). Read the relevant one before a non-trivial change.

## Commands

Node 24 (`.nvmrc`), pnpm 12 (pinned in `packageManager`), Docker.

```bash
pnpm install && cp application/.env.example .env   # .env lives at the repo ROOT
# Set BETTER_AUTH_SECRET, AGENT_API_KEY, VOICE_AGENT_KEY (must differ from AGENT_API_KEY),
# APPROVAL_SECRET (each >= 32 chars: openssl rand -hex 32). Offline: MODEL_MODE=fake VOICE_MODE=fake
pnpm build            # everything; the basecamp CLI, API and tests all run from dist/
pnpm infra:up         # Postgres/PostGIS, Redis, MinIO, Mailpit, pgAdmin, LiveKit, whaloc (WhatsApp emulator)
pnpm db:migrate       # framework migrations first, then the application's
pnpm templates:sync   # register WhatsApp templates with whaloc
pnpm dev              # framework tsc -w watchers + `basecamp dev` (API, worker, apps, voice worker, Studio)
```

- `pnpm lint`: Biome check (`pnpm format` fixes it). Style: single quotes, 2-space indent, 100 columns.
- `pnpm typecheck` and `pnpm test` run through turbo. `pnpm lint:deps` runs the dependency-cruiser boundary rules.
- CI (`.github/workflows/ci.yml`) runs lint, build, typecheck, lint:deps, db:migrate and test with
  `MODEL_MODE=fake`. A second `consumer` job packs every `@hykr/*` package, scaffolds an app with
  `create-basecamp` from the tarballs, then builds and typechecks it. If you change a package's public
  exports or `files`, that job is what catches it.
- `pnpm db:generate --name <name>` generates the application's migration from `application/domain/src/db/schema.ts`.
  Never hand-edit files under `*/drizzle/`.
- `pnpm eval` runs the scripted assistant eval and needs the API running. From `application/`:
  `pnpm exec basecamp eval voice|whatsapp [--live]`.
- `pnpm dev` passes `--concurrency=30` because turbo runs 16 persistent tasks. Pass it too if you call
  `turbo run dev` yourself.

### Running tests

Package names: `framework/<dir>` is `@hykr/<dir>`. The application packages are `@application/domain`,
`@application/api`, `@application/mobile` and `@application/back-office`, and `application/` itself is
`@application/app`.

```bash
# Unit tests (Vitest, colocated *.test.ts)
cd framework/core && pnpm vitest run src/query/list-grammar.test.ts   # or: -t "test name"
pnpm --filter @application/domain test                              # views + notifications tests

# Framework e2e: boots compiled @hykr/api on a fixture app (tasks/visits); globalSetup migrates itself
pnpm turbo run build --filter=@hykr/api...
cd framework/api && pnpm exec tsc -p test/fixture/tsconfig.json && pnpm vitest run test/framework/pages.e2e.test.ts

# Application e2e: boots application/api/dist/server.js; needs `pnpm db:migrate` first
pnpm turbo run build --filter=@application/api...
cd application/api && pnpm vitest run test/domain/todo.e2e.test.ts
```

E2E test gotchas:
- They import compiled `dist/`, because Vitest's esbuild emits no decorator metadata for Nest. Rebuild after
  every source change. `pnpm test` does the build for you through turbo.
- They need Postgres and Redis up (`pnpm infra:up`). Files run one at a time (`fileParallelism: false`)
  against one database, and turbo runs `@application/api#test` after `@hykr/api#test`.
- Vitest forces `MODEL_MODE=fake`, `WORKER_INLINE=1` and `THROTTLE=off`. The voice e2e tests have no skip
  guard and fail unless `VOICE_AGENT_KEY` is set in `.env`.
- The golden WhatsApp conversations (`application/api/test/whatsapp/`) need `whaloc-test` on :8090, which
  `pnpm infra:up` starts. Without it they skip.
- Don't run a `pnpm dev` worker from another checkout against the same database while the tests run. Its
  `OutboxRelay` takes outbox rows and the notification tests time out.

Other gotchas:
- `basecamp` is compiled, so it only works after `pnpm build`.
- `db:migrate`, `templates:*` and `eval` load `application/api/dist/server.js`, so build first.
- The mobile app's typecheck fails on `@application/domain/*` until the domain is built.
- Compose's `framework/cli/infra/postgres/init.sql` (PostGIS, pgcrypto, the `app` role's `search_path`) only
  runs on a fresh volume. On any other Postgres, run it yourself before migrating.

## Architecture

### Framework / application boundary (enforced by `pnpm lint:deps`, `.dependency-cruiser.cjs`)

- `framework/` never imports `application/`. The application passes its domain in at exactly two points:
  - the server: `application/api/src/server.ts`, through `defineServer({ domain, module, views, notifications, agent, channel, migrations, contributes })`, started by `startApi` / `startWorker`;
  - the app: `application/mobile/src/app/_layout.tsx`, through `<AppShell app catalog registry config />`.
- `application/` imports `@hykr/*` by package name and public subpath only. No relative paths into
  `framework/`, and no `src/` or `dist/` paths.
- Framework libraries never import the runtimes (`api`, `app`, `back-office`, `voice-worker`, `cli`,
  `create-basecamp`).
- `contracts` and `i18n` are leaves. `ui-registry` holds no runtime code: React lives in its `/react`
  subpath. `channels` and `notifications` hold no DB, Nest, queue or policy code.
- The client packages (`app`, `back-office`, `voice-worker`) reach the API only over HTTP, through `@hykr/api-client`.
- `application/domain/src/{contracts,views,notifications}` are isomorphic: the server and the Expo apps both
  load them. They must not import Nest, Drizzle, Mastra, BullMQ, or the domain's `server`, `db` or `agent`
  folders.

### The three design rules

1. **One write path.** Every write, whether from the app, the assistant, WhatsApp, voice or an approval
   replay, goes through `runWrite` in `framework/core/src/write/pipeline.ts`. The steps are validate,
   idempotency (`idempotency-key`), load through scoped repos (another tenant's row is a 404), authorize
   (`allow` / `deny` / `needs_approval`), then run or park, plus an audit row (`audit.events`) in the same
   transaction. Events are published after commit. Never write tables directly from a controller or
   service. Sends from a write go through the outbox (`app.outbox`), never straight to WhatsApp or SMTP.
2. **The assistant is a user.** The Mastra agent (`framework/agents`) has no DB access (`agents-not-to-db`).
   Its tools (generated in `framework/core/src/tools`) call the same HTTP API with
   `x-agent-key` / `x-acting-for` headers, so the same guards, scopes, approvals and audit apply. The agent
   runs inside the API process (`modules/chat/ChatService`) but loops back over HTTP on purpose.
3. **Channels are views.** The app, WhatsApp and voice share one chat service and one thread per person. A
   tool result carries a *present intent* (a view name and a query, not the data). Each channel renders it
   its own way: a component in the app, text and buttons on WhatsApp (the view's `text`), a short sentence
   in voice (the view's `speak`).

### How an entity flows through the stack

The contracts are declared in `application/domain/src/contracts/`: `entitySpec` and `commandSpec` (Zod
schemas, `fieldLabels`, list filterable/sortable/search, `approval`, `views`), collected in
`defineDomain(...)`. `createCatalog(domain)` merges in the platform entities (saved `pages`, `notify.send`,
`handoff.request`). The catalog drives:
- the server: `defineEntity(Spec, { table, owner, customer, access, rules })` and
  `defineCommand(...)` in `application/domain/src/server/`, wired with
  `entityController` / `entityHandlers` / `commandController` into `DomainModule`;
- the agent tools: `list-*`, `get-*`, `create-*`, `update-*`, `delete-*`, plus one per command;
- the typed client (`@hykr/api-client`, built at runtime from the spec, nothing to codegen) and the app hooks
  (`useEntityList`, `useEntity`, `useEntityMutation`, `useCommand` in `framework/app/src/framework/hooks.ts`);
- the views (`defineView` / `defineScreen` in `application/domain/src/views/`), bound to React components in
  `application/mobile/src/domain/bindings.tsx`.

The tables (`application/domain/src/db/schema.ts`) live in the `app` schema. Use `id()`, `tenantColumn()`,
`customerColumn()` and `user` from `@hykr/db`. Each table needs an owner column plus `createdBy`,
`createdAt` and `updatedAt`. The framework's migrations are tracked in `drizzle.__framework_migrations` and
the application's in `drizzle.__app_migrations`.

Tenancy: every row belongs to a business. The roles are `owner`, `admin`, `ops`, `staff` and `customer`, and
an entity's `access` grants each role `own`, `customer` or `tenant` per read and write (the sample is in
`application/domain/src/server/access.ts`). A WhatsApp-only principal can be refused with
`minAssurance: 'session'`.

### Non-obvious rules (each one has bitten someone)

- Fields a command writes must be in the entity's update schema. Otherwise `repo.update` drops them silently
  or the command returns a bare 500. Guard such fields with a rule that checks `ctx.via`.
- Inside a command, pass `via` to every repo call and list every changed record in `touched`.
- Repo calls inside a command publish no entity events. Publish a `NamedEvent` from `run` if a notification
  should react.
- Entity `rules` can only deny: a `needsApproval` from a rule is ignored. Use `spec.approval` or a command's
  `authorize` instead.
- A command's `approval.by` says who decides. Without it, the person decides on their own assistant's request.
- Return `deny(...)` with a stable `rule` code and a plain `reason` instead of throwing. The caller gets
  403 `{ error: 'forbidden', rule, reason }`. "Not yours" is a 404, never a 403.
- WhatsApp templates (`defineTemplate`) are versioned forever. To change the wording, add `_v2`;
  `templates:sync` refuses an edit to an approved template.
- Every user-facing word is `Labels` (`{ en, hi, te }`), which won't compile with a language missing. A list
  view that can be spoken needs `noun` and `empty`.
- The scripted model (`MODEL_MODE=fake`, `framework/agents/src/fake`, with the domain scripts in
  `application/domain/src/agent/scripts.ts`) is what tests and CI use. Its replies are asserted in golden
  files, so its wording matters.
- `framework/app` keeps colour tokens in both `src/theme.ts` and `theme.css`. Its `test` script
  (`scripts/check-tokens.mjs`) fails if they drift apart.
- `framework/create-basecamp/template/` is a copy of `application/` made at pack time. Don't edit it; it is
  git-ignored.

A framework change needs its own tests: e2e tests in `framework/api/test/framework` against the fixture
app in `framework/api/test/fixture`. Framework tests must not depend on the sample domain.

Extension points (developer guide, section 5.9): spec `traits`, `contributes` lists collected by
registries (`createHookRegistry`, in `framework/core/src/hooks.ts` and `framework/api/src/hooks.ts`),
and settings sections (`defineSettingsSection`). Each is extended by declaration merging. Add a new
kind in your own file instead of editing a central one. Decisions per unit are in `docs/decisions/`.

## Tooling notes

- **Turborepo:** `AGENTS.md` asks agents to read the installed turbo's bundled docs before changing turbo
  config or commands, because this version may differ from what you remember. Resolve the package
  (`node -p "require.resolve('turbo/package.json')"`) and read its `docs/README.md` first.
- **Expo (`application/mobile`):** its `AGENTS.md` says not to trust remembered Expo APIs. Check the `expo`
  major version and read the versioned docs at `https://docs.expo.dev/versions/v<major>.0.0/`. Add packages
  with `npx expo install` so the versions match the SDK. Never hand-edit `ios/` or `android/`, which are
  generated. The app lists native modules it doesn't import itself (LiveKit, WebRTC, speech, SQLite, secure
  store), because the framework's voice and storage need them. Keep them.
