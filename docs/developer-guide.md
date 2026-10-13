# Basecamp developer guide

**Basecamp is the agentic development stack for full-stack applications.** This guide is for developers who build a business on it. It covers how the pieces fit, where your code goes, the rules the framework enforces, and how to test and ship a feature.

To learn by doing, start with the tutorial, [Build a feature end to end: site visits](tutorial.md). It adds one feature through every layer, with tested code. Section 5 of this guide is the reference for the same steps.

Everything here describes the code as it is in this repository. File paths are relative to the repository root. The framework lives in `framework/` as `@hykr/*` packages; the application built on it, the sample domain, lives in `application/`. If this guide and the code disagree, the code wins. Please fix the guide when that happens.

---

## 1. What this framework is

You declare your business once, in a typed spec: its records (entities), its multi-step actions (commands), who may do what, and what needs a person's approval. The framework builds the rest from that spec:

- REST routes, with validation and a list grammar (filters, search, sort, keyset pages).
- Tools for the assistant (`list-*`, `get-*`, `create-*`, `update-*`, `delete-*`, and one per command).
- Typed client methods and React data hooks for the app.
- Scoping by business (tenant), role and customer, on every read and write.
- Approvals: a write that needs a person's yes is parked, then replayed when someone approves it.
- An audit row for every write, refusal and decision.
- History lines, approval cards, and how the assistant shows results on screen, on WhatsApp and in speech.

The template ships with a sample domain: meetings, notes and to-dos, in `application/`. It shows every feature. You replace it with your own (see `DOMAIN.md` at the root), or start a new application from the same sample with `npm create @hykr/basecamp <folder>`. The framework never imports the application: the application passes its domain in, through `defineServer` (`application/api/src/server.ts`) and `<AppShell>` (`application/mobile/src/app/_layout.tsx`).

### The three rules

These three rules explain almost every design choice in the codebase.

1. **One write path.** Every write goes through `runWrite` in `framework/core/src/write/pipeline.ts`: validate, idempotency, load, authorize, park or run, audit. That holds whether the write comes from the app, the assistant, WhatsApp, voice or an approval replay. No feature writes to the database any other way.
2. **The assistant is a user.** The assistant has no database access. Its tools call the same HTTP API the app calls, as an agent principal acting for a person (`x-agent-key`, `x-acting-for`). The same rules, scopes, approvals and audit apply. A dependency-cruiser rule (`agents-not-to-db`) keeps it that way.
3. **Channels are views.** The app, WhatsApp and voice all reach one chat service (`framework/api/src/modules/chat`) and one thread per person. A tool result carries a *present intent*, such as "show the `todo.list` view with this query". Each channel draws it in its own way: a component in the app, words and buttons on WhatsApp, a short sentence in voice.

---

## 2. How it fits together

```mermaid
flowchart LR
  subgraph Clients
    M["application/mobile<br/>Expo app on @hykr/app :8081"]
    B["application/back-office<br/>staff inbox on @hykr/back-office :8082"]
    V[framework/voice-worker<br/>LiveKit agent]
    W[WhatsApp / whaloc :8080]
  end

  D[application/api/src/server.ts<br/>defineServer: domain, module,<br/>views, notifications, agent]

  subgraph API["@hykr/api startApi : NestJS :3000"]
    G[PrincipalGuard<br/>session or agent key]
    C[Generated controllers<br/>entityController / commandController]
    CH[ChatService<br/>/api/chat]
    RW[runWrite<br/>validate, idempotency, load,<br/>authorize, park or run, audit]
    AP[ApprovalService<br/>/api/approvals]
    WH[webhooks/whatsapp]
  end

  subgraph Worker["@hykr/api startWorker : application/api/src/worker.ts"]
    Q[BullMQ queues<br/>wa-inbound, wa-send,<br/>notify-dispatch, ...]
  end

  A[framework/agents<br/>Mastra assistant + tools]
  PG[(Postgres<br/>app, audit, channel, mastra)]
  R[(Redis)]

  D -.->|passed in| API
  D -.->|passed in| Worker
  M -->|cookie session| G
  B -->|cookie session| G
  V -->|x-agent-key relay| G
  W --> WH --> Q
  Q --> CH
  G --> C --> RW
  G --> CH --> A
  A -->|HTTP as agent, acting for a person| G
  RW --> PG
  RW -->|parks| AP
  AP -->|replays| RW
  Q --> R
```

Read the diagram like this:

- The API and the queue worker are `@hykr/api`. The application starts them with its own definition: `application/api/src/main.ts` calls `startApi(server)` and `worker.ts` calls `startWorker(server)`, where `server = defineServer({ ... })`. `basecamp dev` and `basecamp start api|worker` run the same thing.
- People call the API with a Better Auth session cookie. `PrincipalGuard` turns the request into a `Principal`: who is acting, for whom, in which business, with which roles.
- The assistant runs inside the API process (`ChatService` calls Mastra), but its tools go back out over HTTP to the same API, with agent headers. That round trip is on purpose: the assistant passes through every guard, rule and audit row.
- WhatsApp messages arrive at `POST /webhooks/whatsapp`. They are stored, queued, and processed by the queue worker (`startWorker`), which runs a chat turn and queues the reply.
- The voice worker is a *relay*: it may only start chat turns (`@RelayAllowed()` routes) for the person in the call.

### What a write does

Every write, from any caller, follows these steps in `runWrite`:

| Step | What happens | Where |
|---|---|---|
| Validate | `op.input.parse(rawInput)`, again, even after the controller parsed it | `pipeline.ts` |
| Idempotency | Same `idempotency-key` and same body returns the stored answer. Same key with a different body is a 409. | `app.idempotency` table |
| Load | `op.load(tx, p, input)` through scoped repos. A row that is not yours is a 404. | entity repo |
| Authorize | Returns `allow`, `deny` or `needs_approval` | `def.decide` or your command's `authorize` |
| Deny | The transaction rolls back. A `denied` audit row is written. The caller gets 403 `{ error: 'forbidden', rule, reason }`. | |
| Park | Inserts an `app.approvals` row and a `needs_approval` audit row. Returns `{ status: 'needs_approval', approval }`. | `approvals.ts` |
| Run | `op.run(...)` inside the transaction | your command or the entity repo |
| Audit | One row per touched record, plus one for a command | `audit.events` |
| Events | Published after commit by the CQRS handler | `NamedEvent` |

Every write answers a `WriteResult` (`framework/contracts/src/framework/write.ts`):

```ts
{ status: 'done', value } | { status: 'needs_approval', approval }
```

---

## 3. Where things live

### The application: the folders you replace

The application is `application/`. Its `package.json` (`@application/app`) holds the `"basecamp"` block (where the compiled server, the watched packages, the apps and the migrations are) and the scripts. The framework never imports any of it. The application hands each layer's `index` to the framework: the server definition in `application/api/src/server.ts`, and the catalog and registry in `application/mobile/src/domain/index.ts`. The dependency-cruiser rule `framework-never-imports-application` enforces this (`pnpm lint:deps`).

| Path | What lives there | You edit it when |
|---|---|---|
| `application/domain/src/contracts/` | Zod schemas, `entitySpec`s, `commandSpec`s, and `domain = defineDomain({ name, entities, commands })` | You add or change a record, a field, a list filter, an approval rule or a command |
| `application/domain/src/db/schema.ts` | Drizzle tables in the `app` schema | You add a table or a column |
| `application/domain/drizzle/` | Generated SQL migrations and `meta/_journal.json`, recorded in `drizzle.__app_migrations` | After `pnpm db:generate --name <name>`. Never edit by hand. |
| `application/domain/src/server/` | `defineEntity` / `defineCommand`, Nest modules, `access.ts`, and `DomainModule` in `index.ts` | You wire a new entity or command into the API, or change who sees what |
| `application/domain/src/notifications/` | `domainTemplates` (`defineTemplate`) and `domainNotifications` (`defineNotification`) | Your business sends reminders or WhatsApp templates |
| `application/domain/src/views/` | `uiDomain = { views, screens }` (`defineView`, `defineScreen`) | The assistant should show a record or a list in a new way |
| `application/domain/src/agent/` | `agentDomain`: persona, rules, help, scripted-model scripts, eval cases | You teach the assistant your business, or add evals |
| `application/api/src/server.ts` | `server = defineServer({ domain, module, views, notifications, agent, channel, migrations })`; `main.ts` and `worker.ts` start it | You add a layer, or change what the WhatsApp welcome and HELP say the assistant does (`channel.does`) |
| `application/mobile/src/domain/` | `catalog = createCatalog(domain)`, `registry = createUiRegistry(uiDomain)`, `appDomain = defineAppDomain({ tagline, nav, suggestions, bind })`, React components for your views, screens | You draw a view in the app or add nav items |
| `application/mobile/src/app/(domain)/` | Expo Router routes for your screens. `index.tsx` is the home screen. `_layout.tsx` renders `<AppShell>`. | You add an app screen |
| `application/api/test/domain/`, `application/api/test/whatsapp/`, `application/domain/src/views/*.test.ts` | Your domain's e2e, golden WhatsApp and view tests | Always, with the feature |

### The framework: the folders you read

You should rarely need to change these. When you do, it is a framework change and needs its own tests (in `framework/api/test/framework`, against the fixture application in `framework/api/test/fixture`).

| Path | What lives there |
|---|---|
| `framework/contracts/src/framework/` | `entitySpec`, `commandSpec`, `defineDomain`, the list grammar, present intents, `WriteResult` |
| `framework/contracts/src/platform/` | The framework's own entities (saved `pages`) and commands (`notify.send`, `handoff.request`) |
| `framework/contracts/src/catalog.ts` | `createCatalog(domain)`: the domain's entities and commands plus the platform's. Tools, hooks and history read from a catalog. |
| `framework/core/src/` | `defineEntity`, `defineCommand`, `runWrite`, `ApprovalService`, guards, controller factories, list SQL. `src/tools/` builds agent tools (imported as `@hykr/core/tools`). |
| `framework/policy/src/` | `accessFor`, `rowAllowed`, `DEFAULT_ACCESS`, `subjectOf`, `userIdOf` |
| `framework/db/src/schema/`, `framework/db/drizzle/` | Tenancy, approvals, idempotency, audit, channel tables and their migrations (`drizzle.__framework_migrations`); `app`, `id()`, `tenantColumn()`, `customerColumn()` for your tables |
| `framework/agents/src/` | `createAgents`, the Mastra assistant, profiles, the fake model, scorers, Studio; script helpers in `@hykr/agents/script`, the evals harness in `@hykr/agents/evals` |
| `framework/ui-registry/src/` | `defineView`, `createUiRegistry`, platform views; `react.ts` for `bindView` / `bindScreen` |
| `framework/i18n/src/` | `LANGS`, `Labels`, the framework's phrases (`messages.ts`), date and plural formatting |
| `framework/channels/src/` | WhatsApp transport only: adapter, render, split, keywords, approval tokens |
| `framework/notifications/src/` | `defineTemplate`, `defineNotification`, `createNotificationCatalog`, quiet hours and marketing cap rules |
| `framework/api-client/src/` | `createApiClient`: `entity(spec)`, `command(spec, input)`, and typed calls for every framework route |
| `framework/api/src/runtime.ts`, `start.ts` | `defineServer`, `startApi`, `startWorker`, `migrate`, `runTemplates`, `runEval`, `startStudio`. `testing.ts` is `@hykr/api/testing`. |
| `framework/api/src/channels/` | WhatsApp webhook, queues, sending, notifications dispatch, template sync, handoff, back office API, erasure |
| `framework/api/src/modules/` | Chat, threads, history, me, voice, pages |
| `framework/app/src/` | `AppShell`, `defineAppDomain`, data hooks (`framework/hooks.ts`), `InlineView`, chat runtime, canvas store and `PageHost`; primitives in `@hykr/app/ui` |
| `framework/cli/` | The `basecamp` command, plus the `compose.yaml` and `infra/` it starts |

### Import rules

`.dependency-cruiser.cjs` holds these rules. All are errors. CI runs `pnpm lint:deps`.

| Rule | What it means for you |
|---|---|
| `framework-never-imports-application` | Nothing in `framework/` imports `application/` or `@application/*`. The application passes its domain in. |
| `application-uses-public-framework-exports` | The application imports `@hykr/*` packages by name and public subpath, as from npm: no relative paths into `framework/`, no `src/`, `dist/` or tests. |
| `framework-libraries-not-to-runtimes` | The libraries never import the runtimes (`api`, `app`, `back-office`, `voice-worker`, `cli`, `create-basecamp`). |
| `domain-specs-and-views-are-isomorphic` | `application/domain`'s `contracts`, `views` and `notifications` are read by the server and the apps alike: no `server`, `db` or `agent` folder, no `@hykr/db`, `policy`, `core`, `agents` or `api`, no `@nestjs`, `drizzle-orm`, `@mastra` or `bullmq`. |
| `apps-read-only-isomorphic-domain` | The Expo apps read the domain's contracts and views only, never its server, tables, assistant or `application/api`. |
| `contracts-stays-a-leaf`, `i18n-is-a-leaf` | `@hykr/contracts` imports no framework package except `@hykr/i18n`. `@hykr/i18n` imports nothing at all. |
| `agents-not-to-db` | The assistant never imports `@hykr/db`. It reaches data through the API. |
| `core-not-to-mastra`, `core-tools-not-to-db` | Mastra is used only in `framework/core/src/tools/`, and those tools never touch the database. |
| `db-policy-not-to-mastra` | `db` and `policy` know nothing about the model. |
| `ui-registry-no-runtime` | The registry imports only contracts and i18n. React bindings live in `@hykr/ui-registry/react`. |
| `channels-is-transport`, `notifications-are-definitions` | These packages hold no database, queue, Nest or policy code. Sending and consent live in `@hykr/api`. |
| `clients-hold-no-server-code` | `@hykr/app`, `@hykr/back-office` and `@hykr/voice-worker` talk to the API over HTTP only. |

---

## 4. Your first hour

### Setup

You need Node 24 (`.nvmrc`), pnpm 12 (`packageManager` in `package.json`) and Docker.

```bash
pnpm install
cp application/.env.example .env
```

The `.env` stays at the repository root: the `basecamp` command loads the nearest `.env` at or above the application's root (`application/`), and the tests read it too. Fill these in `.env`. Each one must be at least 32 characters. Generate each with `openssl rand -hex 32`:

- `BETTER_AUTH_SECRET`
- `AGENT_API_KEY`
- `VOICE_AGENT_KEY` (must differ from `AGENT_API_KEY`; the API refuses to start otherwise, because audit tells them apart)
- `APPROVAL_SECRET` (signs WhatsApp approval buttons; without it approvals are decided in the app only)

To run without any model or speech keys, set:

```bash
MODEL_MODE=fake     # scripted assistant, no OPENROUTER_API_KEY needed
VOICE_MODE=fake     # voice worker takes text in, gives text out
```

Then build, start the services, migrate and run:

```bash
pnpm build             # the CLI, the API and the tests run from dist/
pnpm infra:up          # docker compose: every service in framework/cli/compose.yaml
pnpm db:migrate        # the framework's migrations, then the application's
pnpm templates:sync    # sends WhatsApp templates to whaloc; needs the build and whaloc
pnpm dev               # the framework in watch mode, then basecamp dev: API + queue worker,
                       # mobile web, back office, voice worker, Studio
```

The root scripts call the `basecamp` command (`@hykr/cli`) inside `application/`. You can run it there yourself: `cd application && pnpm exec basecamp <dev | start api|worker|voice | infra up|down | db migrate | db generate | templates sync|check | eval | studio>`. `pnpm exec basecamp --help` lists them.

Check it is up:

```bash
curl http://localhost:3000/health     # {"ok":true}
```

Things that will trip you up:

- Most of `pnpm dev` reloads on save. Each framework package runs `tsc -w` into its `dist/`. `basecamp dev` (the application's `dev` script) compiles `application/domain` and `application/api` the same way, restarts the API and queue worker under `node --watch` when any module they loaded changes, and both Expo apps fast-refresh through Metro. The voice worker runs from its build (`node …/@hykr/voice-worker/dist/main.js dev`) without a watcher. An edit in `framework/*` reaches every app that imports it. `pnpm dev` passes `--concurrency=30` because turbo runs 16 persistent tasks (15 framework watchers and the application's `basecamp dev`) and its default is 10; pass it too when you run `pnpm turbo run dev` yourself.
- `basecamp dev` also starts the voice worker, which exits at startup if `VOICE_AGENT_KEY` is missing or short, or if `VOICE_MODE=live` has no `SARVAM_API_KEY` (`assertConfig()` in `framework/voice-worker/src/config.ts`). `basecamp dev` reports `voice … exited (1)`, keeps the other processes running, and does not start the worker again. `application/.env.example` ships `VOICE_AGENT_KEY=` empty and `VOICE_MODE=live`. Set `VOICE_AGENT_KEY` and `VOICE_MODE=fake`, then restart `pnpm dev`.
- Mobile web serves on 8081 and the back office on 8082. If something else holds either port, Expo cannot ask for another one (`basecamp dev` gives it no terminal), so that app exits.
- With `MODEL_MODE=live` (the default in `.env.example`) and no `OPENROUTER_API_KEY`, chat answers 503 "Set OPENROUTER_API_KEY in .env to use the assistant".
- Stop the services with `pnpm infra:down` (or `basecamp infra down`). They run as the Compose project `basecamp` from `framework/cli/compose.yaml` (an application can name its own with `"project"` in its `basecamp` block), so a plain `docker compose down` at the root finds nothing.
- `basecamp` is compiled: in this repository it works only after `pnpm build`, and says so until then. `pnpm infra:up` runs `docker compose` directly and needs no build.
- `templates:sync`, `templates:check`, `db:migrate` and `eval` load the application's compiled server (`application/api/dist/server.js`, the `server` entry of the `basecamp` block). Build first.
- Compose's Postgres runs `framework/cli/infra/postgres/init.sql` (postgis and pgcrypto extensions, and `ALTER ROLE app SET search_path = public`) only on a fresh volume. On any other Postgres, run it yourself before `pnpm db:migrate`, or Better Auth's tables land in the `app` schema.

### Local tools

| Tool | URL | What for |
|---|---|---|
| API | http://localhost:3000 | `GET /health`; `GET /me` shows the principal the API sees for you |
| Mobile app (web) | http://localhost:8081 | The product |
| Back office | http://localhost:8082 | Staff inbox for WhatsApp handoffs |
| Bull Board | http://localhost:3000/admin/queues | Queues. Sign in to the app as an owner or admin first. Not mounted in production. |
| whaloc | http://localhost:8080 | WhatsApp Cloud API emulator with a chat UI |
| Mailpit | http://localhost:8025 | Email sent by notifications |
| pgAdmin | http://localhost:5050 | `admin@example.com` / `admin`; server `app` (host `postgres`, user `app`) is preregistered |
| Mastra Studio | http://localhost:4000 | Try the assistant and its tools, and read traces. `pnpm dev` starts it once the API is up and skips it if ports 4000 or 4111 are taken; it restarts when the agent's code changes. On its own: `cd application && pnpm exec basecamp studio` (needs the API running) |
| LiveKit | ws://localhost:7880 | Voice rooms (dev keys `devkey` / `secret`) |
| MinIO | http://localhost:9001 | Runs in compose, but no code uses it yet |

Postgres is on `localhost:5432` (`app` / `app` / `app`). Redis is on `localhost:6379`.

### One feature on three channels

The sample to-do shows the whole loop. Try it before you write any code.

**1. The app.** Open http://localhost:8081, sign up, and add a to-do on the To-dos screen. That is `POST /api/todos` through `useEntityMutation('todos')`.

**2. The assistant in the app.** In the chat, type `add Call the plumber`, then `delete Call the plumber`. With `MODEL_MODE=fake` the scripted model calls `create-todo`, then `list-todos` and `delete-todo`. The delete is parked, because the spec says so:

```ts
// application/domain/src/contracts/todo.ts
// An agent never deletes without the person.
approval: { delete: (p) => p.actor.kind === 'agent' },
```

An approval card appears in the chat. Approve it, and the to-do is gone.

**3. The raw API.** The same calls, as a person:

```bash
# Sign up. Better Auth wants a trusted Origin.
curl -c jar -H 'origin: http://localhost:8081' -H 'content-type: application/json' \
  -d '{"name":"Ana","email":"ana@example.com","password":"password123"}' \
  http://localhost:3000/api/auth/sign-up/email

curl -b jar -H 'content-type: application/json' -d '{"title":"Order tiles"}' \
  http://localhost:3000/api/todos
# {"status":"done","value":{"id":"…","title":"Order tiles","done":false,…}}

curl -b jar 'http://localhost:3000/api/todos?done=false&sort=-createdAt'
# {"items":[…],"nextCursor":null}
```

**4. WhatsApp.** The business number must be claimed by your tenant before inbound messages are handled. Otherwise the inbound processor marks them `unknown number`:

```bash
curl -b jar -H 'content-type: application/json' -d '{}' \
  http://localhost:3000/api/channels/whatsapp/number
```

A number belongs to the first business that claims it, and is never moved to another: a second business gets 409. In development, `{}` claims `WA_PHONE_NUMBER_ID`; in production you must name the `phoneNumberId`. If another local account already holds the dev number, free it with `delete from channel.numbers where phone_number_id = '<id>';`.

Then open whaloc at http://localhost:8080 and write to the seeded number (+91 80 4000 0100) from a new phone number. You are a customer of the business now. Write `list`. The reply is the `todo.list` view's `text`, sent as WhatsApp words. You see only your customer's rows, which is none yet. To act as yourself on WhatsApp, link your number in the app (the app calls `POST /api/channels/whatsapp/code`, then `POST /api/channels/whatsapp/verify`).

### Find yourself in the audit log

Every write you just made is in `audit.events`. Open pgAdmin or `psql` and run:

```sql
SELECT at, action, outcome, actor_kind, actor_id, acting_for, channel, rule, reason, run_id
FROM audit.events
ORDER BY at DESC
LIMIT 20;
```

You will see `todo.create` rows with `actor_kind = 'user'`, the agent's `todo.delete` with `outcome = 'needs_approval'`, then `approval.approved` and the replayed `todo.delete` with `approved_by` set to you.

To follow one assistant turn, take the `x-run-id` response header from `/api/chat` (or `runId` from `/api/chat/once`):

```sql
SELECT at, action, outcome, actor_kind, acting_for, rule, reason, before, after
FROM audit.events WHERE run_id = '<run-id>' ORDER BY at;

SELECT id, action, status, summary, approver_user_id, approver_roles, expires_at, failure_reason
FROM app.approvals WHERE run_id = '<run-id>';
```

To see what an approval replay did, find rows that share the approve call's request id:

```sql
SELECT at, action, outcome, actor_kind, approved_by, rule FROM audit.events
WHERE request_id = (SELECT request_id FROM audit.events
                    WHERE action = 'approval.approved' AND resource_id = '<approval-id>')
ORDER BY at;
```

The app shows the same data per record through `GET /api/history?resourceType=todo&resourceId=<id>`.

---

## 5. Declaring your domain

Work in this order:

1. The spec (`application/domain/src/contracts`)
2. The table (`application/domain/src/db/schema.ts`)
3. The migration (`pnpm db:generate`)
4. `defineEntity` / `defineCommand` (`application/domain/src/server`)
5. A Nest module
6. Add it to `DomainModule`
7. Views, app bindings, assistant scripts, notifications (as needed)

`application/api/src/server.ts` already passes each layer's `index` to `defineServer`, so a new entity needs no change there.

### 5.1 The entity spec

`entitySpec` lives in `framework/contracts/src/framework/spec.ts` (import it from `@hykr/contracts`). You give it the parts below. It fills `plural` (`${name}s`), `pascal`, `expose` (every action `'all'`, merged with yours) and `approval` (`{}`).

| Field | Meaning |
|---|---|
| `name` | Singular, lower case. Used in routes, command names (`todo.create`), tool ids and audit `resource_type`. |
| `plural`, `pascal` | Derived unless you give them. Give `plural` when "s" is wrong. |
| `label` | How people say it ("to-do"). Used in messages such as `No such to-do`. |
| `fieldLabels` | `{ field: { en, hi, te } }`. Field names in the approval preview. |
| `description` | Goes into tool descriptions. Write it for the model. |
| `schemas` | `{ read, create, update }`, all `z.object(...)` |
| `list` | The list grammar config (see 5.6) |
| `expose` | Per action: `'all'`, `'human'` or `'internal'` (see 5.7) |
| `approval` | Per write action: when it parks and who decides (see 5.8) |
| `views` | `{ list?, item? }`: registered view names the tools present results with |

The sample to-do:

```ts
// application/domain/src/contracts/todo.ts
export const TodoSpec = entitySpec({
  name: 'todo',
  label: 'to-do',
  description: "The user's to-dos: short tasks with an optional due date, optionally linked to a meeting.",
  schemas: { read: Todo, create: CreateTodoInput, update: UpdateTodoInput },
  fieldLabels: { title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' }, /* … */ },
  list: {
    filterable: { done: 'boolean', dueOn: 'date', meetingId: 'id', title: 'text' },
    sortable: ['dueOn', 'createdAt', 'title'],
    defaultSort: [['createdAt', 'asc']],
    search: ['title'],
    pageSize: { default: 50, max: 100 },
    examples: { done: 'false', dueOn: '{ "lte": "2026-10-31" }', /* … */ },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'todo.list', item: 'todo.item' },
});
```

Update schemas in the sample refuse an empty patch:

```ts
.refine((v) => Object.values(v).some((x) => x !== undefined), 'Send at least one field to change')
```

Read schemas can use the exported `CreatedBy = z.enum(['person', 'assistant'])`.

Register the spec in `application/domain/src/contracts/index.ts`. The key must be the plural, or `defineDomain` throws at load:

```ts
export const domain = defineDomain({
  name: 'Meetings',
  entities: { todos: TodoSpec, notes: NoteSpec, meetings: MeetingSpec },
  commands: [CloseMeetingSpec, RescheduleMeetingSpec],
});
```

### 5.2 The table

Add tables to `application/domain/src/db/schema.ts`, in the `app` schema. Use the helpers `@hykr/db` exports (`app`, `id`, `tenantColumn`, `customerColumn`, `user`):

```ts
export const todos = app.table('todos', {
  id: id(),
  tenantId: tenantColumn(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  customerId: customerColumn(),
  title: text('title').notNull(),
  done: boolean('done').default(false).notNull(),
  dueOn: date('due_on'),
  meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  createdBy: text('created_by', { enum: ['person', 'assistant'] }).notNull().default('person'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  index('todos_owner_id_idx').on(table.ownerId),
  index('todos_tenant_customer_idx').on(table.tenantId, table.customerId),
]);
```

What the framework requires:

- JS keys named exactly `id` and `tenantId`, plus an owner column. Otherwise `defineEntity` throws `<name>: table needs id, tenantId and owner columns`.
- Owner and customer columns can have any key. You point at them with a function.
- `createdBy` is optional. If it exists, the framework sets it to `'assistant'` for an agent and `'person'` otherwise.
- Every field named in `list` must be a column key, or the list query throws `List config names "x", which is not a column`.
- Entity routes use `ParseUUIDPipe` for `:id`, so ids must be UUIDs. `id()` gives `gen_random_uuid()::text`.

Then generate and apply the migration:

```bash
pnpm db:generate --name <your-change>   # basecamp db generate: drizzle-kit in application/domain
pnpm db:migrate                         # the framework's migrations, then the application's
```

`application/domain/drizzle.config.ts` manages only your tables in the `app` schema, and records what ran in `drizzle.__app_migrations`. The framework's tables (`public`, `app`, `audit`, `channel`) ship with `@hykr/db` (`framework/db/drizzle`, recorded in `drizzle.__framework_migrations`) and are applied first. Mastra owns `mastra` and `mastra_obs`.

### 5.3 defineEntity

`defineEntity` (`framework/core/src/entity/define-entity.ts`) joins the spec to its table:

```ts
// application/domain/src/server/todos/todo.entity.ts
export const Todo = defineEntity(TodoSpec, {
  table: todos,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
});
```

| Option | Meaning |
|---|---|
| `table` | The Drizzle table |
| `owner` | The owner column. Used for `'own'` access, and set on create. |
| `customer` | The customer column, for `'customer'` access. Optional. |
| `access` | Who reaches which rows (see 6.2). Defaults to `DEFAULT_ACCESS`. |
| `rules` | `EntityRule[]`: domain checks on writes |
| `summarize` | `(action, input, row) => string`: the approval card text. The default uses `title`: `Delete "Call the plumber"`. |
| `events` | Publish `<entity>.created/updated/deleted` after commit. Default `true`. |

An entity rule has this shape:

```ts
type EntityRule<T> = (p, action, row, input, ctx: { via: 'crud' | string }) => AuthorizeResult | null;
```

Return `deny(rule, reason)` to refuse, or `null` to pass. `ctx.via` is `'crud'` for a plain route, or the command's name when a command calls the repo. The meeting uses that to force closing through its command:

```ts
// application/domain/src/server/meetings/meeting.entity.ts
(_p, action, _row, input, ctx) =>
  action === 'update' && input?.status === 'closed' && ctx.via !== 'meeting.close'
    ? deny('use_close_meeting', 'Close a meeting with close-meeting, so its summary and to-dos are written')
    : null,
```

The returned `EntityDef` has a scoped `repo` for use inside commands: `get`, `find`, `list`, `insert`, `update` and `delete`. Every query is limited to the principal's tenant and grants. Someone else's id is a 404. Writes re-parse the input, run the rules, and strip `id`, owner, `createdBy`, `tenantId` and customer from the input.

### 5.4 Commands

Use a command when one action touches several records, or has rules a plain update cannot express. Declare it in contracts:

```ts
// application/domain/src/contracts/commands.ts
export const CloseMeetingSpec = commandSpec({
  name: 'meeting.close',
  description: 'Close a meeting in one step: …',
  input: CloseMeetingInput,
  output: CloseMeetingResult,
  http: { method: 'POST', path: '/api/meetings/:meetingId/close' },
  tool: 'close-meeting',
  expose: 'all',
  approvalNote: 'When you call it, the whole close waits for the user to approve it.',
  view: { name: 'meeting.card', id: (input) => input.meetingId },
  verb: { do: 'close', did: 'closed' },
  touches: ['meeting', 'note', 'todo'],
});
```

| Field | Meaning |
|---|---|
| `name` | Dotted, as audited |
| `http` | Method and path. Path params (`:meetingId`) come from the input. The rest is the body. |
| `tool` | The agent's tool id. Leave it out to keep the command off the agent. |
| `expose` | `'all'` or `'human'`. There is no `'internal'` for commands. |
| `approvalNote` | Added to the tool description |
| `view` | What the tool result shows |
| `verb` | Words for approval cards and history ("Approve close", "closed it") |
| `touches` | Entity names the app refreshes after the command runs |

Then implement it in the API with `defineCommand` (`framework/core/src/command/define-command.ts`):

```ts
// application/domain/src/server/meetings/close-meeting.command.ts
export const CloseMeeting = defineCommand(CloseMeetingSpec, {
  resource: { type: 'meeting', id: (input) => input.meetingId },
  load: (tx, p, input) => Meeting.repo.get(tx, p, input.meetingId), // scoped: 404 if not theirs
  authorize: (p, meeting) => {
    if (meeting.status === 'closed') return deny('already_closed', 'This meeting is already closed');
    if (p.actor.kind === 'agent') return needsApproval('agent_close', 'Closing a meeting needs your approval');
    return allow('owner_closes');
  },
  summarize: (input, meeting) =>
    `Close ${meeting.title} with 1 note and ${todosLabel(input.actionItems.length)}`,
  run: async ({ tx, principal, input, loaded: meeting, via }) => {
    const note = await Note.repo.insert(tx, principal, { /* … */ meetingId: meeting.id }, via);
    // … Todo.repo.insert(tx, principal, { ...item, meetingId: meeting.id }, via) for each item
    const closed = await Meeting.repo.update(tx, principal, meeting, { status: 'closed' }, via);
    return {
      value: { meeting: closed, note, todos },
      touched: [{ type: 'meeting', id: meeting.id, change: 'updated', before: meeting, after: closed }, /* … */],
      events: [new MeetingClosed(closed, note, todos)],
    };
  },
});
```

Points to keep in mind:

- Always pass `via` to repo calls. Entity rules see it as `ctx.via`.
- Every record you change goes into `touched`. Each entry becomes an audit row.
- `authorize` alone decides whether a command parks. The optional `approval` config (`{ by, channels, minAssurance }`) only says who decides.
- A domain event is a class that implements `NamedEvent` (`eventName` and `row`). Notifications can schedule on it:

```ts
export class MeetingClosed implements NamedEvent {
  readonly eventName = 'meeting.closed';
  get row() { return this.meeting; }
  constructor(readonly meeting: unknown, readonly note: unknown, readonly todos: unknown[]) {}
}
```

### 5.5 Nest wiring

The controller and handler factories live in `framework/core/src/http/controller-factory.ts` and `entity/handlers.ts`:

```ts
// application/domain/src/server/meetings/meetings.module.ts
@Module({
  controllers: [entityController(Meeting), commandController(CloseMeeting), commandController(RescheduleMeeting)],
  providers: [...entityHandlers(Meeting), commandHandler(CloseMeeting), commandHandler(RescheduleMeeting)],
})
export class MeetingsModule {}

// application/domain/src/server/index.ts
@Module({ imports: [TodosModule, NotesModule, MeetingsModule] })
export class DomainModule {}
```

`defineServer({ module: DomainModule })` hands it to the framework, which imports it in both the API and the queue worker. That gives you:

| Route | Status |
|---|---|
| `GET /api/<plural>` | list, with the list grammar |
| `GET /api/<plural>/:id` | get |
| `POST /api/<plural>` | create, 201 |
| `PATCH /api/<plural>/:id` | update |
| `DELETE /api/<plural>/:id` | delete |
| `spec.http.method spec.http.path` | the command, 200 |

`entityHandlers` and `commandHandler` also register each op for approval replay. You need both the controller and the handler. A controller without its handler has nothing to run, and a parked op without its handler fails as "can no longer be replayed".

### 5.6 The list grammar

`ListConfig` (`framework/contracts/src/framework/list.ts`):

| Field | Meaning |
|---|---|
| `filterable` | `{ field: FieldType }`, where the type is one of `'enum'`, `'date'`, `'text'`, `'number'`, `'boolean'`, `'id'` |
| `sortable` | Fields you may sort by |
| `defaultSort` | `[[field, 'asc' \| 'desc'], …]` |
| `search` | Columns matched by `q`, case-insensitive, OR-ed. Without it there is no `q`. |
| `pageSize` | `{ default, max }` for HTTP |
| `toolPageSize` | The agent tool's maximum rows. Default 20. |
| `examples` | Shown in the tool description |

Operators by type:

| Type | Operators |
|---|---|
| `enum`, `id` | `eq`, `ne`, `in` |
| `boolean` | `eq`, `ne` |
| `text` | `eq`, `ne`, `in`, `contains` |
| `date`, `number` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte` |

The same filter in its two forms:

```text
HTTP:  GET /api/todos?done=false&dueOn[lte]=2026-10-31&sort=-dueOn&limit=20
JSON:  { done: false, dueOn: { lte: '2026-10-31' }, sort: '-dueOn', limit: 20 }
```

- The JSON form is what tools and `repo.list` take. `toQueryString(input)` turns it into the HTTP form.
- `in` takes a comma list over HTTP.
- `count: true` adds `total`.
- Unknown fields or operators are a 400. That is on purpose.

The response is `{ items, nextCursor, total? }`. Pagination is keyset: pass `nextCursor` back as `cursor`. A cursor from a different sort is a 400 `cursor_sort_mismatch`. Sorting on a nullable column works only for dates, timestamps and numbers. A nullable text or enum column in `sortable` passes load-time checks, then throws `Sorting on nullable ... is not supported` (`framework/core/src/query/list-grammar.ts`) on the first request that sorts by it, which the client sees as a 500. Keep such columns `notNull()` or out of `sortable`.

### 5.7 Expose: who can reach an action

| `expose` | HTTP route | Agent tool | Use it for |
|---|---|---|---|
| `'all'` | yes | yes | The default |
| `'human'` | yes, with `HumanOnlyGuard` | no, and an agent call is denied `humans_only` | Irreversible actions. The meeting's `delete` is `'human'`. |
| `'internal'` | no | no | Records only commands should write, through `def.repo` |

For commands, `'human'` gives a people-only route. To keep a command off the agent, leave out `tool`.

### 5.8 Approvals: when a write parks

On an entity spec, `approval[action]` decides whether a write parks:

```ts
type ApprovalRule =
  | 'always' | 'never'
  | ((p: Principal) => boolean)
  | { when?: 'always' | ((p) => boolean); by?: TenantRole[] | 'self'; channels?: Channel[]; minAssurance?: Assurance };
```

- The function form is the common one: `(p) => p.actor.kind === 'agent'`.
- The object form also says who decides and where. For example, `{ when: (p) => p.actor.kind === 'agent', by: ['owner', 'admin'], channels: ['app'] }`. `channels: ['app']` keeps an irreversible decision off WhatsApp buttons. No sample entity uses the object form yet. The one real example is a command: `approval: { by: ['owner', 'admin'] }` in `framework/api/src/channels/notify/send-template.command.ts`.

Who decides, when `by` is not set: the person the request is for, if they are a user and not only a customer. Otherwise, the business's `owner` and `ops`.

Approvals expire after 24 hours by default (`CoreModule.forRoot({ approvalTtlMs })`). Expiry is checked when someone tries to decide.

---

## 6. Principals and policy

### 6.1 The principal

Every request becomes a `Principal` (`framework/contracts/src/principal.ts`). The important fields:

| Field | Meaning |
|---|---|
| `actor` | `{ kind: 'user' \| 'agent', id, role }`. `role` is deprecated; use `roles`. |
| `actingFor` | For an agent: the person it acts for |
| `subject` | Whose business this is: `{ kind: 'user', userId }` or `{ kind: 'contact', contactId }`. Set by the server only. |
| `tenantId`, `roles`, `customerId` | The business, your roles in it, and your customer record if you are one |
| `assurance` | `'whatsapp_number'` (a number alone) or `'session'` (signed in) |
| `channel` | `'app'`, `'voice'` or `'whatsapp'` |
| `runId`, `agentVersion` | Set on agent calls, and written to audit |
| `approvedBy` | Set on an approval replay |

Everything comes from server data. Headers only choose: `x-tenant-id` picks among the businesses you belong to, and a WhatsApp channel lowers assurance. Sign-up creates the person's own business, with them as `owner` (a Better Auth `user.create.after` database hook in `framework/api/src/infra/auth.ts`). If that failed, `PrincipalGuard` creates it on their first call (`ensureDefaultTenant`).

A WhatsApp customer who has not linked an account acts as `actor.kind: 'user'` with id `contact:<id>`, roles `['customer']`.

Read `p` in your rules with the helpers in `@hykr/policy`: `subjectOf(p)`, `userIdOf(p)`, `subjectKeyOf(p)`.

### 6.2 Access

`Access` (`framework/policy/src/access.ts`) says, per role, which rows a read or write reaches:

| Grant | Rows |
|---|---|
| `'own'` | `owner = you`. Only for a user subject. |
| `'customer'` | `customer_id = your customer`. Only when you are a customer. |
| `'tenant'` | Every row in the business |

The sample's rules:

```ts
// application/domain/src/server/access.ts
export const BUSINESS_ACCESS: Access = {
  read:  { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};
```

Ask for a signed-in session on a write with `{ grant: 'customer', minAssurance: 'session' }`. A WhatsApp-only customer is then refused with rule `needs_assurance`.

When a customer creates a row, the row is owned by the business's default owner (`tenants.default_owner_id`) and gets the customer's id.

### 6.3 The order of checks on an entity write

`def.decide` checks in this order. The first one that refuses wins.

1. Write access needs more assurance: deny `needs_assurance`.
2. No grant, or the row is outside your grants: deny `no_access`.
3. An agent, and the action is not exposed `'all'`: deny `humans_only`.
4. Your entity `rules`: the first deny wins.
5. `spec.approval[action]` parks: `needs_approval`, rule `<name>_<action>_needs_approval`.
6. Otherwise allow, rule `scoped_access`.

---

## 7. The assistant and how it shows things

### 7.1 Tools come from specs

You do not write tools for entities or commands. `toolsFor` in `framework/core/src/tools` builds them from `entities` and `commands` in the catalog (`createCatalog(domain)`, built by `defineServer`):

| Spec | Tools |
|---|---|
| Entity, action exposed `'all'` | `list-<plural>`, `get-<name>`, `create-<name>`, `update-<name>`, `delete-<name>` |
| Command with `tool` and `expose: 'all'` | `spec.tool` |
| Profile `app` only | `canvas-open`, `canvas-compose`, `canvas-patch` |

Tool descriptions are built from the spec's `description`, the list grammar and `examples`. A tool whose write would park says so in its description.

A tool never throws a refusal at the model. It returns `{ ok: false, status, error }` and the model explains it.

### 7.2 Teaching the assistant your business

Edit `application/domain/src/agent/index.ts` (the `AgentDomain` type comes from `@hykr/agents/script`):

```ts
export const agentDomain: AgentDomain = {
  persona: 'You are a meetings assistant. You help the user plan meetings, keep notes, and track action items.',
  rules: [ /* domain rules, one sentence each */ ],
  help: 'I can add, list, complete or delete to-dos, show today, and close or move meetings.',
  scripts: domainScripts,
  evalCases,
  voiceEvalCases,
  evalSetup: async (api) => { await api('POST', '/api/meetings', { /* … */ }); },
};
```

The framework adds its own rules before yours (`FRAMEWORK_RULES` in `framework/agents/src/version.ts`). Among them: look up before you change, never invent ids, and do not retry after a refusal.

On WhatsApp, the welcome and the HELP reply say what the assistant does in one sentence per language. That sentence is `channel.does` in `defineServer` (`application/api/src/server.ts`), not part of `agentDomain`. Without it, WhatsApp uses the framework's generic `channel.does` phrase from `framework/i18n/src/messages.ts`.

### 7.3 The scripted model

With `MODEL_MODE=fake`, `fakeModel` in `framework/agents/src/fake/engine.ts` answers with scripts instead of an LLM. Tests, evals and CI use it. A script matches the user's text, calls a tool, and then speaks once the result is back:

```ts
// application/domain/src/agent/scripts.ts
defineScript({
  name: 'add',
  match: (text) => command(VERBS.add, text),
  step: (title, turn) => {
    const r = turn.result('create-todo');
    if (!r) return [call('create-todo', { title })];
    const added = (t: { title: string }) =>
      ({
        en: `Added ${quoted(t.title)}.`,
        hi: `${quoted(t.title)} जोड़ दिया।`,
        te: `${quoted(t.title)} జోడించాను.`,
      })[turn.lang];
    return [say(written(r, added, turn))];
  },
}),
```

`VERBS`, `command` and `quoted` are local helpers in `application/domain/src/agent/scripts.ts`, not exports. Put new scripts in that file, or copy the helpers.

Helpers you will use, all from `@hykr/agents/script`: `call`, `say`, `sayIn(turn, { en, hi, te })`, `verbs(...)`, `items(outcome)`, `written(...)`.

The fake model reads the language, surfaces and canvas from the system prompt with regular expressions. If you change the wording of `buildInstructions` in `framework/agents/src/version.ts`, scripted tests can break silently.

### 7.4 Views and present intents

A tool result carries a `present` intent (`framework/contracts/src/framework/present.ts`): `inline`, `open`, `page`, `patch` or `text`. Each channel draws it differently:

| Surface | Where | What it draws |
|---|---|---|
| `inline` | App chat | The view's bound React component |
| `canvas` | App, wide pane | Screens and saved pages of blocks |
| `text` | WhatsApp | `view.text(props, ctx)`, with buttons or lists for choices |
| `speech` | Voice | `view.speak(props, ctx)` |

Define a view in `application/domain/src/views/`, with `defineView` from `@hykr/ui-registry`:

```ts
export const TodoListView = defineView({
  name: 'todo.list',
  description: '…', // the agent reads it; say when not to use it
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Todo) }),
  source: { entity: TodoSpec, into: 'items' }, // fetched by query; the agent never writes `items`
  actions: { toggle },                         // action<Todo>({ command: 'todo.update', args: (t) => ({ id: t.id, done: !t.done }) })
  labels,                                      // { title, empty } as { en, hi, te }; noun as { en: ['to-do', 'to-dos'], hi: [...], te: [...] }
  text: (p, ctx) => /* WhatsApp words */,
  speak: (p, ctx) => spokenList(p.items.map((t) => t.title), labels, ctx),
});
```

Add it to `uiDomain.views`. `createUiRegistry` refuses a spoken list view without `labels.noun` and `labels.empty`.

Bind it to a component in the app, in `bindDomain()` in `application/mobile/src/domain/bindings.tsx`:

```ts
bindView(TodoListView, TodoListComponent); // bindView from @hykr/ui-registry/react
```

The component gets the props, plus `act(actionName, item)` and `words`:

```tsx
export function TodoListComponent({ title, items, act, words }: ViewProps<typeof TodoListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(t) => <TodoLine todo={t} onToggle={() => act('toggle', t)} />}
      </Rows>
    </ViewCard>
  );
}
```

`act` runs through `useAct`. It calls the entity or the command as the person, shows a toast when a write is parked, and refreshes queries.

---

## 8. Channels, notifications and voice

### 8.1 WhatsApp

You do not write WhatsApp code for a feature. Inbound messages become chat turns on the `text` surface. Your views' `text` decides the words. Approvals become signed buttons when `APPROVAL_SECRET` is set and the approver is the person writing. The framework handles keywords (STOP, START, HELP, talk to a person, delete my data, link my account) in English, Hindi and Telugu, plus consent, the 24-hour window, handoff to a person and erasure.

### 8.2 Templates and notifications

Anything your business sends on its own goes through a template and a notification, declared in `application/domain/src/notifications/index.ts` with `defineTemplate` and `defineNotification` from `@hykr/notifications`:

```ts
export const MeetingReminder = defineTemplate({
  name: 'meeting_reminder_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(60), time: z.string().max(60) }),
  body: {
    en: 'Reminder: {{title}} at {{time}}.',
    hi: 'रिमाइंडर: {{title}} {{time}} पर है।',
    te: 'రిమైండర్: {{title}} {{time}}కి ఉంది.',
  },
  buttons: [{ type: 'quick_reply', id: 'snooze_15', text: { en: 'Snooze 15 min', hi: '15 मिनट बाद', te: '15 నిమిషాల తర్వాత' } }],
  example: { title: 'Site visit', time: '4:30 pm' },
});
```

`defineTemplate` checks the template when it loads:

- The name must match `/^[a-z][a-z0-9_]*_v\d+$/`.
- Every language needs a body, and each body's `{{placeholders}}` must equal the param keys.
- At most three quick replies.
- A marketing template needs an opt-out button or footer.
- The example must parse.

`defineNotification` says when, to whom and on which channels:

| Field | Meaning |
|---|---|
| `key` | e.g. `'meeting.reminder'` |
| `topic` | `'service'`, `'reminders'` or `'marketing'` (consent and quiet hours follow the topic) |
| `schedule` | `{ on: [events], at: (row) => Date \| null, cancelOn?: [events] }` |
| `send` | `{ on: [events] }`: send now |
| `when` | `(row) => boolean`: checked at send time |
| `to` | `(row) => [{ userId } \| { customerId } \| { contactId } \| { roles }]` |
| `channels` | Fallback order, e.g. `['whatsapp', 'email']` |
| `whatsapp` | `{ template, params(row, reader) }`. Required, even for email-only. |
| `email` | `{ subject, body }`. Required when `'email'` is in `channels`. |
| `onButton` | `{ [buttonId]: (row) => { reschedule?: Date; reply?: Labels } \| undefined }` |
| `approval` | `(row) => approvalId`: the quick replies `approve` and `reject` decide that approval |
| `dedupe` | Required. `(row) => string`: one pending schedule per key |

Event names are `<entity>.created|updated|deleted`, your commands' `NamedEvent`s, and `approval.requested` / `approval.decided`.

Add the template and notification to `domainTemplates` and `domainNotifications`. Then run:

```bash
pnpm build
pnpm templates:sync     # creates new templates at the provider (whaloc locally)
pnpm templates:check    # passes once every template a notification uses is approved in English
```

Never edit an approved template's words. `templates:sync` fails with "bump the version". Make `_v2` instead.

The usual way to send is an event plus `schedule` or `send.on`. `NotifyService.notify(def, row, tx)` (`framework/api/src/channels/notify/notify.service.ts`) is an instance method inside `@hykr/api`, not an export; a `defineCommand` `run` gets only `{ tx, principal, input, loaded, via }` and has no service to call. To send from inside a command, insert into the outbox with the command's transaction, as `framework/api/src/channels/notify/send-template.command.ts` does (`schema` from `@hykr/db`):

```ts
await tx.insert(schema.outbox).values({
  tenantId: principal.tenantId ?? '',
  key: def.key,
  payload: { row, dedupe: def.dedupe(row) },
});
```

Either way the send is part of the write, so a rollback sends nothing. The outbox relay runs only in the queue worker, or in the API with `WORKER_INLINE=1`.

### 8.3 Voice

Voice is a framework channel. The worker (`@hykr/voice-worker`, started by `basecamp dev` or `basecamp start voice`) calls `/api/chat` as a relay for the person in the call. Surfaces are forced to `['inline', 'canvas', 'speech']`. A feature needs only:

- `speak` on its views.
- `labels` with `noun` and `empty` on spoken lists.
- Optionally `voiceEvalCases`.

---

## 9. Languages

The product speaks English, Hindi and Telugu (`LANGS` in `framework/i18n/src/lang.ts`). `Labels` is `Readonly<Record<Lang, string>>`, so a missing translation does not compile.

| Words | Where they go |
|---|---|
| Framework phrases ("Waiting for your approval") | `framework/i18n/src/messages.ts`: add the key to `en`, `hi` and `te`. The test checks the placeholders match. |
| View titles, empty lines, nouns | View `labels` |
| Field names in approval previews | Entity `fieldLabels` |
| Scripted answers | `sayIn(turn, { en, hi, te })`, and `VERBS` with `verbs(...)` |
| Template bodies | `defineTemplate` `body` |
| What the assistant does, in the WhatsApp welcome and HELP | `channel.does` in `defineServer` |

Some app copy is still English only: toasts in `useAct`, tool-line labels in `ToolPart`, and the `text` of `approval.card` and `kpi.row`.

---

## 10. Recipes: how do I…

**…add a field to an existing entity?**
Add it to the read, create and update schemas. Add the column to the table. Run `pnpm db:generate --name <change>` and `pnpm db:migrate`. If people filter on it, add it to `list.filterable`, and to `list.examples` so the assistant learns it. Add a `fieldLabels` entry.

**…add an entity?**
Follow section 5.

**…make the assistant ask before it does something?**
On an entity, set `approval: { <action>: (p) => p.actor.kind === 'agent' }` on the spec. On a command, return `needsApproval('<rule>', '<reason>')` from `authorize`.

**…make something people-only?**
On an entity, set `expose: { delete: 'human' }`. On a command, set `expose: 'human'`, or leave out `tool`.

**…enforce a business rule ("a closed meeting cannot reopen")?**
Add an entity `rule` that returns `deny(rule, reason)`. It runs on every path, including inside commands. Use `ctx.via` to allow a path only through one command.

**…let ops and admins see the whole business?**
Give the entity `access` with `'tenant'` for those roles, like `BUSINESS_ACCESS`.

**…let customers reach their own rows from WhatsApp?**
Add `customerColumn()` to the table, pass `customer: (t) => t.customerId` to `defineEntity`, and give the `customer` role the `'customer'` grant.

**…read other records inside a command?**
Use `OtherEntity.repo.get(tx, p, id)` or `OtherEntity.repo.list(tx, p, { …filters, limit: 100 })`. Both are scoped. Inside a command `list` allows up to 1000 rows.

**…change how a result looks in chat, on WhatsApp or in speech?**
Change the view's component (app), its `text` (WhatsApp) or its `speak` (voice). Point the spec's `views` or the command's `view` at it.

**…send a reminder?**
Define a template and a notification (section 8.2), then run `templates:sync`.

**…call the API from a script or another service?**
Use `createApiClient({ baseUrl, headers: () => ({ cookie }) })` from `@hykr/api-client`. `headers` is a function, `() => Record<string, string> | Promise<Record<string, string>>`, called on every request; web callers may pass `credentials: 'include'` instead. Then call `api.entity(TodoSpec).list({ done: false })` or `api.command(CloseMeetingSpec, input)`. Writes send a fresh idempotency key unless you pass one. A server-side sign-in through Better Auth also needs an `origin` header. To act as the assistant, send `x-agent-key`, `x-agent-id: assistant`, `x-acting-for` and an `x-run-id` matching `/^[A-Za-z0-9_-]{1,64}$/` (`framework/core/src/http/principal.ts`).

**…see why something was refused?**
The 403 body has `rule` and `reason`. The `audit.events` row with `outcome = 'denied'` has the same.

**…run the assistant without a model key?**
Set `MODEL_MODE=fake`. Add a script in `application/domain/src/agent/scripts.ts` for any new phrase you want covered.

**…add a business member?**
There is no invitation flow yet. Tests insert into `app.memberships` directly (`addMember` in `@hykr/api/testing`). Do the same with SQL locally.

---

## 11. Rules of the road

| Do | Don't | Why |
|---|---|---|
| Write through repos, commands and generated routes | Write to tables with Drizzle in a controller or service | You would skip rules, approvals, idempotency and audit |
| Pass `via` to every repo call inside a command | Call repos without it | Entity rules use `ctx.via` to tell paths apart |
| List every changed record in `touched` | Leave out records the command changed | Audit and history would miss them |
| Return `deny(...)` with a stable `rule` and a plain `reason` | Throw generic errors for business refusals | Refusals are audited, shown to people, and explained by the assistant |
| Keep specs pure: Zod, `@hykr/contracts` and `@hykr/i18n` | Import Node, Nest or Drizzle in `application/domain/src/contracts` | The server and the apps load the same specs. `domain-specs-and-views-are-isomorphic` blocks Nest, Drizzle, Mastra, BullMQ and the server-only `@hykr/*` packages; Node built-ins are kept out by convention only. |
| Give the assistant data through the API | Import `@hykr/db` in `framework/agents` | `agents-not-to-db`. The assistant is a user. |
| Mark irreversible agent actions for approval | Trust the model to ask first | The prompt is advice. The spec is enforced. |
| Write `description`s and `examples` for the model | Leave them vague | They are the tool descriptions the model reads |
| Add a new version of a template (`_v2`) | Edit an approved template | Providers re-review templates; `templates:sync` refuses the edit |
| Add words in all three languages | Hard-code English in views | `Labels` will not compile without them; the channels speak three languages |
| Use the outbox to send from a write (events plus `schedule`/`send.on`, or `tx.insert(schema.outbox)` inside a command) | Call WhatsApp or SMTP directly | A rollback must send nothing, and a crash after commit must still send |
| Let 404 mean "not yours" | Return 403 for someone else's id | No hint that a record exists |

---

## 12. Testing your feature

| Layer | What it proves | Where | Run |
|---|---|---|---|
| Lint and format | Style | whole repo | `pnpm lint` |
| Types | Specs, tables and handlers agree | whole repo | `pnpm typecheck` |
| Dependency rules | The boundaries in section 3 | `framework`, `application` | `pnpm lint:deps` |
| Package unit tests | List grammar, policy, views, i18n, templates, channels | `framework/*/src/**/*.test.ts` | `pnpm test` |
| View and notification tests | `text` and `speak` output, your templates | `application/domain/src/views/views.test.ts`, `application/domain/src/notifications/notifications.test.ts` | `pnpm --filter @application/domain test` |
| Framework e2e | Platform features, on a fixture application (tasks and visits) | `framework/api/test/framework/*.e2e.test.ts`, fixture in `framework/api/test/fixture` | `cd framework/api && pnpm test` |
| API e2e | Your routes, scoping, approvals, chat with the fake model | `application/api/test/domain/*.e2e.test.ts` | `cd application/api && pnpm vitest run test/domain` |
| Golden WhatsApp | Full conversations against whaloc-test | `application/api/test/whatsapp/conversations/*.yaml` | whaloc-test runs with `pnpm infra:up`; then `cd application/api && pnpm vitest run test/whatsapp` |
| Assistant evals | The right tools in the right order, and good replies | `application/domain/src/agent/evals.ts` | `pnpm eval`; in `application/`, `pnpm exec basecamp eval voice` or `eval whatsapp` (`--live` for the real model) |
| Native UI | App flows | `application/mobile/maestro/*.yaml` | `maestro test maestro/demo.yaml -e EMAIL=… -e PASSWORD=…` |

API e2e tests boot the compiled app, against real Postgres and Redis, with the fake model. The helpers are in `@hykr/api/testing` (`framework/api/src/testing.ts`), imported compiled, and a test boots the application's compiled server (`application/api/dist/server.js`), because Vitest's esbuild emits no decorator metadata. They need `pnpm build` first and a migrated database. `pnpm test` does the build for you through turbo.

```ts
import { boot, Person, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const alice = new Person('Alice');
beforeAll(() => boot(application));
afterAll(shutdown);

it('the agent asks before deleting', async () => {
  await alice.signUp();
  await alice.call('POST', '/api/todos', { title: 'Call the plumber' });
  const del = await alice.chat('delete Call the plumber');
  expect(del.body.toolCalls.map((c: { tool: string }) => c.tool)).toEqual(['list-todos', 'delete-todo']);
  const [approval] = (await alice.call('GET', '/api/approvals')).body;
  expect(approval.summary).toBe('Delete "Call the plumber"');
});
```

Other helpers: `me(person)`, `addMember(person, tenantId, roles)`, `seedContact(tenantId, name, address)`, `asAssistant(actingFor)` (agent headers), `eventually(check)`, `pool` (direct SQL) and `server` (the running Nest app). `@hykr/api/testing/internals` gives a test the services it drives directly: `NotifyService`, `TemplateSync`, `WHATSAPP` and `DB`.

An eval case lists the tools that must run, in order:

```ts
{ why: 'a delete is parked for approval, and says so',
  input: 'delete Order tiles',
  expect: { must: ['list-todos', 'delete-todo'], replyIncludes: 'approv' } },
```

Evals need the API running and are not in CI.

**What CI runs** (`.github/workflows/ci.yml`): install, apply `framework/cli/infra/postgres/init.sql` (extensions and search path), `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm lint:deps`, `pnpm db:migrate`, `pnpm test`. It runs against Postgres, Redis and Mailpit only. Compose runs `init.sql` automatically, but only on a fresh volume. Golden WhatsApp conversations skip themselves without whaloc-test. Evals and Maestro are not run. A second job, `consumer`, packs every `@hykr/*` package, scaffolds an application with `create-basecamp`, installs it from the tarballs, and builds and typechecks it.

---

## 13. Definition of done

A feature is done when every box is ticked:

- [ ] Spec in `application/domain/src/contracts/`, registered in `defineDomain`. `description`, `label`, `fieldLabels` and list `examples` are written for the model.
- [ ] Table in `application/domain/src/db/schema.ts` with `id`, `tenantColumn()`, an owner column, `createdBy`, `createdAt`, `updatedAt`, and `customerColumn()` if customers have rows. Indexes match your filters and sorts.
- [ ] A migration generated with `pnpm db:generate` and committed under `application/domain/drizzle/`.
- [ ] `defineEntity` / `defineCommand` with the right `access`, `rules` and `authorize`. Every command passes `via` and lists everything it changes in `touched`.
- [ ] Nest module with controllers *and* handlers, imported in `DomainModule`.
- [ ] Every action the agent should not do alone has an approval rule, or is `expose: 'human'`.
- [ ] Views for list and item, with `text`, `speak` and `labels` in `en`, `hi` and `te`. They are bound in the app (`bindDomain` in `application/mobile/src/domain/bindings.tsx`).
- [ ] Scripts for the fake model, and eval cases for new phrases.
- [ ] Templates and notifications, if the feature sends anything. `pnpm templates:check` passes.
- [ ] An e2e test in `application/api/test/domain/` covering: a stranger gets 404, a denied rule gets 403 with its `rule`, and a parked agent write shows up in approvals.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm lint:deps` and `pnpm test` pass. `pnpm eval` passes.
- [ ] You found your feature's rows in `audit.events`.

---

## 14. Not ready yet

These are not built. Each has a workaround for now.

| Missing | What to do now |
|---|---|
| Invitations to a business | Insert into `app.memberships` with SQL, as `addMember` in `@hykr/api/testing` does |
| Seed data | Create data through the API or the app. Maestro's demo assumes data exists. |
| File uploads | MinIO runs in compose, but no code uses it. There is no upload API yet. |
| OpenAPI | Nothing generates or serves an OpenAPI document. `@nestjs/swagger` is not a dependency; only a comment in `spec.ts` mentions it. |
| Production deploy | No Dockerfile, deploy workflow or `eas.json`. Only `ci.yml`. |
| A system principal | `actor.kind` is `user` or `agent` only. Maintenance jobs write audit rows with `actorKind: 'system'` directly. Background domain writes have no principal to run as. |
| Read models or custom queries (`defineQuery`) | Use `list` with the grammar, or a command that loads through repos. |
| Filtering for null (`dueOn is null`) | The grammar does not accept `null`. Add a boolean column, or filter in a command. |
| Entity rules that park | An entity rule's `needs_approval` is ignored. Only `deny` counts. Use `spec.approval`, or a command whose `authorize` returns `needsApproval`. |
| An approval sweeper | Expiry is checked when someone decides. Expired rows stay `pending` in `GET /api/approvals` until then. |
| Concurrent duplicate requests | Two requests with the same idempotency key at the same moment can both run. Only the first answer is stored. |
| Opt-out from a marketing quick reply | The `stop_offers` button is not handled. The STOP keyword is the only working opt-out. |
| Clearing "unreachable" on WhatsApp | Only the START keyword clears it. |
| Other channels (SMS, Telegram) | `ChannelAdapter.channel` is `'whatsapp'` only. |
| Time zone in `TodoDueNotification` | It hard-codes IST (`+05:30`). Use the tenant's `timeZone` in your own notifications. |
| Root `seed`, `start`, `infra:down`, `studio` scripts | Create data through the API; in `application/`, use `pnpm exec basecamp start api` (and `start worker`, `start voice`), `basecamp infra down` and `basecamp studio`. |
| Web e2e (Playwright) | Use API e2e tests. Maestro covers native flows, outside CI. |
| Voice tests without a key | `pnpm test` runs `framework/api/test/framework/voice.e2e.test.ts` and `application/api/test/voice/say.e2e.test.ts`. They need `VOICE_AGENT_KEY` (worker calls send `x-agent-key: process.env.VOICE_AGENT_KEY ?? ''`) and have no skip guard. CI sets the key in `ci.yml`; locally, set it in `.env` or these tests fail. |

---

## 15. If you read an older design doc

An earlier outline described an API that was never built. Map it like this:

| You may have read | What exists |
|---|---|
| `packages/domain` | `application/domain` (`@application/domain`): one `src/` folder per layer (section 3), listed in `DOMAIN.md` |
| `defineEntity('SiteVisit', { scope: … })` | `entitySpec({ name: 'siteVisit', … })` in the domain's contracts, then `defineEntity(Spec, { table, owner, customer, access, rules })` in its server folder |
| `scope: 'tenant'` | `access: { read: { … }, write: { … } }` with grants `own`, `customer`, `tenant` per role |
| `ruleTable()` | `rules: EntityRule[]` on `defineEntity`, and `authorize` on `defineCommand`, using `allow` / `deny` / `needsApproval` |
| `pnpm gen:client` | Nothing to generate. `@hykr/api-client` builds typed methods from the spec at runtime: `api.entity(Spec)`, `api.command(Spec, input)`. The app uses `useEntityList` / `useEntity` / `useEntityMutation` / `useCommand`. |
| `pnpm infra:up` | Exists: `docker compose up -d` on `framework/cli/compose.yaml` (project `basecamp`); `basecamp infra up` does the same in an application |
| `packages/evals` | `framework/agents/src/evals/` (harness, `@hykr/agents/evals`) and `application/domain/src/agent/evals.ts` (cases). Run with `pnpm eval`. |
| `messages/*.json` | TypeScript: framework phrases in `framework/i18n/src/messages.ts`, and domain words as `Labels` next to the domain code |
| `defineQuery` | Not built. Use the list grammar or a command. |
| A seed command | Not built |

---

## 16. Glossary

| Term | Meaning |
|---|---|
| **Domain** | Your business's records, commands, views, words and notifications: `application/domain`, one folder per layer. |
| **Application** | `application/`: a domain, plus the server definition, app and back office that run it on the framework |
| **Framework** | Everything in `framework/`: the `@hykr/*` packages. It never imports an application. |
| **Entity** | A record type with CRUD, declared with `entitySpec` and `defineEntity` |
| **Command** | A named, audited write that may touch several records: `commandSpec` and `defineCommand` |
| **Spec** | The pure declaration in `@hykr/contracts` that routes, tools, hooks and views are built from |
| **Principal** | Who is acting, for whom, in which business, with which roles and assurance |
| **Actor** | The `user` or `agent` making the call |
| **Subject** | Whose behalf the call is on: a user or a WhatsApp contact |
| **Tenant** | A business. Every row has a `tenant_id`. |
| **Membership** | A person's roles in a tenant (`app.memberships`) |
| **Customer** | A record of a business's customer (`app.customers`). It is not a login. |
| **Contact** | A WhatsApp number known to a business (`channel.contacts`) |
| **Grant** | `own`, `customer` or `tenant`: which rows a role reaches |
| **Assurance** | How sure we are of who it is: `whatsapp_number` < `session` |
| **Expose** | Who can reach an action: `all`, `human` or `internal` |
| **Rule** | A named check that allows, denies or parks a write. Its name is audited. |
| **Approval** | A parked write, waiting for a person's yes. It is replayed when approved. |
| **Relay** | An agent that may only start chat turns for a person (the voice worker) |
| **Run** | One assistant turn. Its `run_id` ties together its tool calls and audit rows. |
| **Present intent** | What a tool result asks a channel to show: `inline`, `open`, `page`, `patch` or `text` |
| **Surface** | Where a result can be drawn: `inline`, `canvas`, `text` or `speech` |
| **View** | A registered way to show data on some surfaces (`defineView`), bound to a component in the app |
| **Screen** | A full canvas destination (`defineScreen`), such as `meeting.detail` |
| **Canvas** | The app's side pane for screens and saved pages of view blocks |
| **Profile** | Which tool set the assistant gets: `app` (with canvas), `inline` or `text` |
| **Scripted model** | The fake LLM (`MODEL_MODE=fake`) that tests and evals use |
| **Template** | A pre-approved WhatsApp message (`defineTemplate`), versioned by name |
| **Notification** | When and to whom a template or email goes (`defineNotification`) |
| **Outbox** | The table that makes a notification part of a write's transaction |
| **Handoff** | A WhatsApp conversation passed to a person in the back office. The assistant stays silent until it is given back. |
| **Audit** | `audit.events`: one row per write, refusal, park and decision |
