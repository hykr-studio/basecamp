# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Basecamp is a framework for full-stack apps where an AI assistant works alongside people under the same rules,
approvals and audit trail. You declare an entity once (a Zod spec), and the framework generates the REST
routes, the agent tools, the app data hooks, approval cards, history, and the WhatsApp and voice rendering.
It is a pnpm + Turborepo monorepo. `framework/` holds the `@hykr/*` packages, which can be published to npm.
`application/` holds one sample application built on them: meetings, notes, to-dos and orders, as four
modules (`application/domain/src/modules/<name>/`).

The long-form references are `docs/developer-guide.md` (architecture, rules, testing, known gaps),
`docs/tutorial.md` (one feature end to end), `docs/new-application.md` (a new product from scratch) and
`DOMAIN.md` (what each application layer must export). Read the relevant one before a non-trivial change.

## Commands

Node 24 (`.nvmrc`), pnpm 12 (pinned in `packageManager`), Docker.

```bash
pnpm install && cp application/.env.example .env   # .env lives at the repo ROOT
# Set BETTER_AUTH_SECRET, AGENT_API_KEY, VOICE_AGENT_KEY (must differ from AGENT_API_KEY),
# APPROVAL_SECRET, SECRETS_KEY (each >= 32 chars: openssl rand -hex 32). Offline: MODEL_MODE=fake VOICE_MODE=fake
pnpm build            # everything; the basecamp CLI, API and tests all run from dist/
pnpm infra:up         # Postgres/PostGIS, Redis, MinIO, Mailpit, pgAdmin, LiveKit, whaloc (WhatsApp emulator)
pnpm db:migrate       # framework migrations first, then the application's
pnpm templates:sync   # register WhatsApp templates with whaloc
pnpm dev              # framework tsc -w watchers + `basecamp dev` (API, worker, apps, voice worker, Studio)
```

- `pnpm lint`: Biome check (`pnpm format` fixes it). Style: single quotes, 2-space indent, 100 columns.
- `pnpm typecheck` and `pnpm test` run through turbo. `pnpm lint:deps` runs the dependency-cruiser boundary rules; `pnpm lint:boundary` fails on product vocabulary in `framework/`.
- CI (`.github/workflows/ci.yml`) runs lint, build, typecheck, lint:deps, db:migrate and test with
  `MODEL_MODE=fake`. A second `consumer` job packs every `@hykr/*` package, scaffolds an app with
  `create-basecamp` from the tarballs, then builds and typechecks it. If you change a package's public
  exports or `files`, that job is what catches it.
- `pnpm db:generate --name <name>` generates the application's migration from every module's
  `application/domain/src/modules/*/db/schema.ts` (one journal). Never hand-edit files under `*/drizzle/`.
  Extensions, triggers and CHECK constraints go in idempotent SQL hooks: `sql/pre/*.sql` and `sql/post/*.sql`
  next to the migrations (`framework/db/sql`, `application/domain/sql`), run on every migrate. `db:migrate`
  takes a lock and refuses a migration drizzle would silently skip (one older than the last applied):
  regenerate it, or recreate the database. After a rebase, `pnpm --dir application exec basecamp db rebase
  --base <branch>` drops this branch's migrations and generates them again on top of the base's.
- A framework feature's fixture tables get their own migration set:
  `FIXTURE_FEATURE=<f> pnpm --filter @hykr/api fixture:generate --name <f>` writes
  `framework/api/test/fixture/src/features/<f>/migrations/` from that folder's `schema.ts`.
- `pnpm --dir application exec basecamp module add <name> [--entity <singular>]` scaffolds a module (both
  halves) and adds its line to each module list.
- `pnpm eval` runs the scripted assistant eval and needs the API running. From `application/`:
  `pnpm exec basecamp eval [assistant|voice|whatsapp] [--module <name>] [--live [--model <ref>]]`
  (`--model` runs the evals on one model of `MODEL_PROVIDERS`).
- Models: `MODEL_PROVIDERS` (JSON) lists the deployment's OpenAI-compatible gateways and their models
  (`<provider>/<model>` refs, regions, prices); `OPENROUTER_API_KEY` adds OpenRouter in development.
  Each business picks among them with its `models` settings section (`PUT /api/models/policy`), which
  fails closed (developer guide 7.5).
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
- Vitest forces `MODEL_MODE=fake`, `WORKER_INLINE=1`, `THROTTLE=off` and `STORAGE_DRIVER=memory` (files in
  the test process; the S3 driver's own test runs against MinIO and skips without it). The voice e2e tests have no skip
  guard and fail unless `VOICE_AGENT_KEY` is set in `.env`.
- Both Vitest configs load the root `.env` into the main process, so `globalSetup` migrates the same database
  the tests use. Turbo runs test tasks uncached and passes them every environment variable.
- The golden WhatsApp conversations (`application/api/test/whatsapp/`) need `whaloc-test` on :8090, which
  `pnpm infra:up` starts. Without it they skip.
- `OutboxRelay` only relays outbox rows of its own `BULL_PREFIX`, and each test run uses a fresh one. Two
  processes with the same prefix on one database (two `pnpm dev` workers, both `bull`) still take each other's
  rows: give each checkout its own `BULL_PREFIX`.

Other gotchas:
- `basecamp` is compiled, so it only works after `pnpm build`.
- `db:migrate`, `templates:*` and `eval` load `application/api/dist/server.js`, so build first.
- The mobile app's typecheck fails on `@application/domain/*` until the domain is built.
- Compose's `framework/cli/infra/postgres/init.sql` (PostGIS, pgcrypto, the `app` role's `search_path`) only
  runs on a fresh volume. On any other Postgres, run it yourself before migrating.

## Architecture

### Framework / application boundary (enforced by `pnpm lint:deps`, `.dependency-cruiser.cjs` and `pnpm lint:boundary`)

- `framework/` holds **mechanisms only**. Anything that changes when the business changes is declared by the
  application (modules, `defineServer` contributions) or stored per tenant (settings). It is never a
  constant, enum value, default list, string or framework test wording. That covers role names beyond the
  generic built-ins, what an approval level means and its thresholds, currencies and number formats, tax
  rules, states and SLAs, retention periods, prices, document templates, participant kinds and catalog
  contents. `scripts/check-boundary.sh` (`pnpm lint:boundary`, also in CI) fails on product vocabulary in
  `framework/`. Pre-existing wording is listed in `scripts/boundary-allow.txt`.
- `framework/` never imports `application/`. The application passes its modules in at exactly two points:
  - the server: `application/api/src/server.ts`, through `defineServer({ name, persona, help, channel, modules, migrations, contributes })`, started by `startApi` / `startWorker`. Each module is `defineModule({ ...moduleSpec, server, views, screens, templates, notifications, agent, tables, contributes })`;
  - the app: `application/mobile/src/app/_layout.tsx`, through `<AppShell app modules plugins catalog registry config />`
    (`plugins`: framework features such as `livePlugin()`, `pushPlugin()` and `webMcpPlugin()`).
    Each app module (`defineAppModule` in `application/mobile/src/modules/<name>/index.tsx`) brings its
    nav, suggestions, `bind`, `hrefFor` and `webmcp`; its routes are one-line files in `src/app/<name>/`.
- `application/` imports `@hykr/*` by package name and public subpath only. No relative paths into
  `framework/`, and no `src/` or `dist/` paths.
- Framework libraries never import the runtimes (`api`, `app`, `back-office`, `voice-worker`, `cli`,
  `create-basecamp`).
- `contracts` and `i18n` are leaves. `ui-registry` holds no runtime code: React lives in its `/react`
  subpath. `channels` and `notifications` hold no DB, Nest, queue or policy code. `connectors`
  (signing, sealing, the egress guard, the `Connector` interface) imports only `i18n`, zod and Node.
- The client packages (`app`, `back-office`, `voice-worker`) reach the API only over HTTP, through `@hykr/api-client`.
- A module's `contracts`, `views` and `notifications` folders (and the `src/contracts` and `src/views`
  aggregates) are isomorphic: the server and the Expo apps both load them. They must not import Nest, Drizzle,
  Mastra, BullMQ, or any module's `server`, `db` or `agent` folder.
- A module imports another module only through its `contracts/` or `server/public.ts`, only if it lists it in
  `dependsOn`, and modules form no cycle (`module-*` rules). The apps import only modules' contracts and views.

### The three design rules

1. **One write path.** Every write, whether from the app, the assistant, WhatsApp, voice or an approval
   replay, goes through `runWrite` in `framework/core/src/write/pipeline.ts`. The steps are validate,
   idempotency (`idempotency-key`), load through scoped repos (another tenant's row is a 404), authorize
   (`allow` / `deny` / `needs_approval`, tightened by write hooks), then run or park, plus an audit row
   (`audit.events`) and the write's named events (`app.domain_events`, the durable event outbox) in the
   same transaction. In-process events are published after commit. Never write tables directly from a
   controller or service. Sends from a write go through the outbox (`app.outbox`), never straight to
   WhatsApp or SMTP.
2. **The assistant is a user.** The Mastra agent (`framework/agents`) has no DB access (`agents-not-to-db`).
   Its tools (generated in `framework/core/src/tools`) call the same HTTP API with
   `x-agent-key` / `x-acting-for` headers, so the same guards, scopes, approvals and audit apply. The agent
   runs inside the API process (`modules/chat/ChatService`) but loops back over HTTP on purpose.
3. **Channels are views.** The app, WhatsApp and voice share one chat service and one thread per person. A
   tool result carries a *present intent* (a view name and a query, not the data). Each channel renders it
   its own way: a component in the app, text and buttons on WhatsApp (the view's `text`), a short sentence
   in voice (the view's `speak`).

### How an entity flows through the stack

Each module (`application/domain/src/modules/<name>/`) declares its contracts in `contracts/`: `entitySpec` and
`commandSpec` (Zod schemas, `fieldLabels`, list filterable/sortable/search, `approval`, `views`), collected in
`moduleSpec({ name, dependsOn, entities, commands })`, which stamps each spec with the module (`spec.module`).
`defineServer` merges the modules with `createCatalog(...modules)`, which adds the platform entities (saved
`pages`, `notify.send`, `handoff.request`) and refuses any collision (names, plurals, routes and the framework's
`/api/*` prefixes, tool ids, approval ops, `touches`, `dependsOn` order). The catalog drives:
- the server: `defineEntity(Spec, { table, owner, customer, access, rules })` and
  `defineCommand(...)` in the module's `server/`, wired with
  `entityController` / `entityHandlers` / `commandController` into the module's Nest module;
- the agent tools: `list-*`, `get-*`, `create-*`, `update-*`, `delete-*`, plus one per command;
- the typed client (`@hykr/api-client`, built at runtime from the spec, nothing to codegen) and the app hooks
  (`useEntityList`, `useEntity`, `useEntityMutation`, `useCommand` in `framework/app/src/framework/hooks.ts`);
- the views (`defineView` / `defineScreen` in the module's `views/`), bound to React components in
  each app module's `bind` (`application/mobile/src/modules/<name>/index.tsx`). A view or screen bound
  twice, or bound but missing from the registry, stops the app at startup.

The tables (each module's `db/schema.ts`) live in the `app` schema and are named after the module (`todos`,
`todos_<x>`). Use `id()`, `tenantColumn()`, `customerColumn()`, `user` and `tableRef(name)` (a foreign key to a
module that depends on this one) from `@hykr/db`. Each table needs an owner column plus `createdBy`,
`createdAt` and `updatedAt`. The framework's migrations are tracked in `drizzle.__framework_migrations` and
the application's (one journal for every module) in `drizzle.__app_migrations`.

Tenancy: every row belongs to a business. Roles are names in a registry (`roles` in `@hykr/contracts`;
the framework's are `owner`, `admin`, `ops`, `staff` and `customer`), and an entity's `access` grants each
role `own`, `customer` or `tenant` per read and write (the sample is in
`application/domain/src/server/access.ts`, shared by the modules). Anything else is a capability: check
`can(p, 'backoffice.use')` (`@hykr/policy`), never a role name. A WhatsApp-only principal can be refused with
`minAssurance: 'session'`. Background work writes as `systemPrincipal({ tenantId, job })` from `@hykr/core`.

### Non-obvious rules (each one has bitten someone)

- Fields a command writes must be in the entity's update schema. Otherwise `repo.update` drops them silently
  or the command returns a bare 500. Guard such fields with a rule that checks `ctx.via`.
- Inside a command, pass `via` to every repo call and list every changed record in `touched`.
- A spec with `traits.states` changes its state field only through a transition (`<entity>.transition`,
  or `transition()` inside a command, whose `touched` must carry the row before and after for SLA clocks).
  Entity rules must let `via: '<entity>.transition'` through. A `traits.versioned` record in a
  `frozenWhen` state refuses every other change (`record_frozen`), and its children's tree writes.
- Repo calls inside a command publish no entity events. Publish a `NamedEvent` from `run` if a notification
  should react.
- Entity `rules` park plain CRUD writes only: inside a command a rule's `needsApproval` is ignored and only
  its `deny` counts. A command parks through its own `authorize`.
- Every read leaves through `def.toRead(row, p)`, projected for the principal (entity plugins' `project`,
  then read projectors). Never return a repo row from a controller or service as is.
- A command's `approval.by` says who decides, by capability (`{ capability }`), a named person (`{ userId }`) or
  an amount band in the business's settings (`{ band }`), never by role name. Without it, the person decides
  on their own assistant's request (a customer's goes to holders of `approvals.decide`). Nobody decides
  their own request otherwise.
- What an approval level means is the application's: it declares its levels (`defineApprovalLevel`,
  contributed as `approvalLevels`) and which writes reach them (`defineLevelRule`, `levelRules`); thresholds
  and per-band approvers are tenant settings (`approvals`). A write whose level gives an undo window answers
  with `undo: { id, until }`, and `POST /api/undo/:id` reverses it (developer guide 5.8).
- Money is `Money = { minor, currency }` everywhere (`minorUnits()` columns, the spec's `money` trait), never
  a float or `numeric`. Take a document number with `nextNumber` in a command's `run` (a parked write
  then takes none), and cancel numbered records instead of deleting them. Line items are a child entity
  (`defineChildEntity`, `traits.parent`), written whole with `children.replace` (developer guide 5.13).
- Return `deny(...)` with a stable `rule` code and a plain `reason` instead of throwing. The caller gets
  403 `{ error: 'forbidden', rule, reason }`. "Not yours" is a 404, never a 403.
- WhatsApp templates (`defineTemplate`) are versioned forever. To change the wording, add `_v2`;
  `templates:sync` refuses an edit to an approved template.
- Every user-facing word is `Labels` (`{ en, hi, te }`), which won't compile with a language missing. A list
  view that can be spoken needs `noun` and `empty`.
- The scripted model (`MODEL_MODE=fake`, `framework/agents/src/fake`, with each module's scripts in
  `application/domain/src/modules/<name>/agent/scripts.ts`) is what tests and CI use. Its replies are asserted
  in golden files, so its wording matters. The first matching script wins, earlier modules first, and
  `defineServer` refuses to boot when one module's script would take another module's eval turn. The
  framework's own scripts are script sets in `framework/agents/src/fake/scripts/<feature>.ts` (their `order`
  decides which matches first), and its phrases are in `framework/i18n/src/messages/<feature>.ts`; each file
  has one line in its folder's `index.ts`.
- `defineServer` throws one `ModulesError` listing every collision between modules (and with the framework).
  A framework feature with its own `/api/<x>` routes calls `reserveRoutes('<x>')` (`@hykr/contracts`).
- `framework/app` keeps colour tokens in both `src/theme.ts` and `theme.css`. Its `test` script
  (`scripts/check-tokens.mjs`) fails if they drift apart.
- `framework/create-basecamp/template/` is a copy of `application/` made at pack time. Don't edit it; it is
  git-ignored.
- Files are reached only through the record that holds them (`/api/files`, `docs/decisions/B1.md`). Put a
  file on a record by writing its id into the record's file field (`FileRef`, `fileRefs()`, the `files`
  trait); never write `app.files` yourself. `STORAGE_DRIVER=s3` with MinIO in development (`.env.example`);
  unset means memory, which loses the worker's files to the API.

A framework change needs its own tests: e2e tests in `framework/api/test/framework` against the fixture
app in `framework/api/test/fixture`. Framework tests must not depend on the sample domain.

Extension points (developer guide, section 5.9): spec `traits`, `contributes` lists collected by
registries (`createHookRegistry`, in `framework/core/src/hooks.ts` and `framework/api/src/hooks.ts`),
list field types (`defineListFieldType` plus `listFieldSql`), and settings sections
(`defineSettingsSection`). Each is extended by declaration merging. Add a new kind in your own file
instead of editing a central one. `registerOp` and the entity registry (`entityDefs()`) refuse a
duplicate name. Decisions per unit are in `docs/decisions/`. Section 5.10 says where each runtime
registry is read: every queue comes from the `queues` registry (`defineQueue`, under `BULL_PREFIX`),
framework features are one line each in `framework/api/src/features/index.ts` (`defineFeature`),
event subscribers (`defineSubscriber`) run in the worker on the stored events of
`app.domain_events`, and every chat turn passes the `turnHooks`.

## Tooling notes

- **Turborepo:** `AGENTS.md` asks agents to read the installed turbo's bundled docs before changing turbo
  config or commands, because this version may differ from what you remember. Resolve the package
  (`node -p "require.resolve('turbo/package.json')"`) and read its `docs/README.md` first.
- **Expo (`application/mobile`):** its `AGENTS.md` says not to trust remembered Expo APIs. Check the `expo`
  major version and read the versioned docs at `https://docs.expo.dev/versions/v<major>.0.0/`. Add packages
  with `npx expo install` so the versions match the SDK. Never hand-edit `ios/` or `android/`, which are
  generated. The app lists native modules it doesn't import itself (LiveKit, WebRTC, speech, SQLite, secure
  store), because the framework's voice and storage need them. Keep them.
