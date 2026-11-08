# Basecamp

**The agentic development stack for full-stack applications.**

Basecamp is a starting point for products where an AI assistant works alongside people, with
the same rules, approvals and audit trail as everyone else.

You declare a business entity once. From that declaration it gets a REST API, agent tools,
app screens and data hooks, approval cards, history, and WhatsApp and voice support, with no
hand-written plumbing. The template ships with a sample domain (meetings, notes, to-dos and orders)
that exercises every part of the stack. Replace it with your own.

## The idea

**The assistant has no more power than the person it acts for.** It reads and writes data only
through the same API as the app, under its own key, acting for one person per run. Every
write takes one path:

```
validate → idempotency → load → authorize → run | park for approval | refuse
                                              └── audit row in the same transaction
                                                  events after commit
```

Any operation can be parked for a person to approve. That includes a multi-entity operation
the assistant drafts, such as closing a meeting with a summary note and its to-dos, which is
approved or rejected as one unit. Approving replays the stored operation through the same
path, so the rules apply again at that point. Every audit row carries the channel and the
agent version, and a chat's `runId` is its trace id in Mastra Studio.

## What's inside

| | |
|---|---|
| **API** | NestJS, CQRS, Better Auth, Drizzle on Postgres (PostGIS), Redis rate limiting, BullMQ queues, a durable event outbox written with each write |
| **Assistant** | Mastra agents on the deployment's OpenAI-compatible model gateways (OpenRouter in development), each business's model policy, a scripted model for offline runs, runs that wait for an approval and then resume, memory and recall, agents a business makes itself, Studio, tracing and evals |
| **App** | Expo (web, iOS, Android) with Expo Router, assistant-ui, TanStack Query, Uniwind and React Native Reusables, with live updates, push, offline capture and an in-app inbox |
| **Agent-driven UI** | Tool results carry a view and a query, not data. The client renders them inline or on a canvas, and saved pages hold queries |
| **Records** | States and transitions with SLAs, versions and revisions, line items as child records, money in minor units, gapless number series, a tax function the application supplies, places and geofences, counts and totals, comments and mentions |
| **Approvals** | Levels the application declares (what waits, who decides by capability, named person or amount band, where), thresholds in each business's settings, undo windows, expiry; decided in the app, by push, on a WhatsApp button or by email |
| **Documents and files** | Files on records in S3-compatible storage, PDFs from templates the modules declare, acceptance by one-time code with append-only evidence, share links and public forms |
| **Voice** | LiveKit plus a voice worker using Sarvam speech-to-text and text-to-speech, in the languages the application declares (the sample: English, Hindi and Telugu) |
| **WhatsApp** | Cloud API adapter, signed webhooks, consent and keywords, templates as code, approvals by button, handoff to a back office |
| **Other systems** | Signed outbound webhooks, verified inbound ones through connectors, Google Calendar and ICS feeds, an MCP server with OAuth 2.1 for outside AI clients, WebMCP read tools in the browser, long-running jobs, bulk import |
| **Tenancy** | Businesses, memberships with roles (`owner`, `admin`, `ops`, `staff`, `customer`, plus the application's and each business's own), invitations, per-record grants, fields hidden by capability, customers, participants (people outside the team, on the records they are on) and share-link guests, with a scope engine behind each entity's `access`; platform operators above the businesses, with support access each business consents to |
| **A business's setup** | Feature flags, custom fields, branding and verified domains, shared records, its own wording, settings sections, credits with caps and a prepaid wallet, privacy requests, retention and data export |
| **Tooling** | pnpm workspaces, Turborepo, Biome, dependency-cruiser, Vitest, Maestro, GitHub Actions; `basecamp module add`, `basecamp db rebase` and per-module evals for teams building modules in parallel |

## Repository layout

The framework and the application are separate. `framework/` is Basecamp itself, published as
`@hykr/*` packages; `application/` is one application built on it (the sample domain). The
framework never imports the application: the application passes its domain in. The
application uses the framework only through the packages' public exports, as it would from
npm. `pnpm lint:deps` enforces both rules.

```
framework/                 Basecamp: @hykr/* packages, publishable to npm
  contracts/      moduleSpec, entity and command specs (Zod), traits, roles and capabilities,
                  approval levels, settings sections, the platform's own specs, createCatalog
  core/           defineEntity / defineCommand, the write path, entity plugins, list grammar and
                  summaries, generated tools
  db/             the framework's tables and migrations, builders for an application's tables
  policy/         access and can(): who may do what
  agents/         the assistant (Mastra): createAgents, models, scripted model, scorers, evals
  api-client/     typed client used by the apps, the agents and the voice worker
  ui-registry/    defineView / defineScreen, createUiRegistry
  channels/       WhatsApp adapter, renderer, keywords, signed approval tokens
  connectors/     talking to other systems: webhook signing, sealed secrets, the egress guard,
                  the Connector interface, Google Calendar
  notifications/  templates and notifications as code, dispatch rules
  i18n/           defineLanguages, the framework's phrases, dates, money and counts in words
  api/            the NestJS API and queue worker as a library: defineServer, defineModule,
                  startApi, startWorker, one folder per framework feature (src/features)
  app/            the Expo app shell as a library: AppShell, defineAppModule, hooks, UI kit,
                  assistant, canvas, voice, framework features as plugins
  back-office/    the back office (handoffs, members, settings, privacy, operators) as a library
  voice-worker/   LiveKit agent: speech in, a chat turn for the person, speech and UI parts out
  cli/            the `basecamp` command; Compose and infra
  create-basecamp/  `npm create @hykr/basecamp`: a new application from the one below
  tsconfig/       shared TypeScript settings
application/               one application on the framework: the sample domain
  package.json    the "basecamp" block (where the server and apps are) and scripts
  domain/         src/modules/<name>/: one folder per module (contracts, db, server, views,
                  notifications, agent); the lists of modules, src/server (access, approval
                  levels, privacy), src/languages.ts, drizzle/ (one journal), sql/ (SQL hooks)
  api/            server.ts = defineServer({ ... }); main.ts, worker.ts; the application's e2e tests
  mobile/         Expo app: <AppShell> plus the app modules (src/modules) and their routes
  back-office/    Expo web app on @hykr/back-office
docs/                      developer guide, tutorials, modules guide, decisions per unit of work
```

## Getting started

### Prerequisites

- Node 24 (see `.nvmrc`) and pnpm 12 (`corepack enable` picks up the pinned version)
- Docker, for the local services
- Optional: an [OpenRouter](https://openrouter.ai) key for a live model, and a
  [Sarvam](https://dashboard.sarvam.ai) key for real speech. Without them, everything runs on
  scripted fakes.

### Setup

```bash
pnpm install
cp application/.env.example .env
# Fill in BETTER_AUTH_SECRET, AGENT_API_KEY, VOICE_AGENT_KEY (not the same as AGENT_API_KEY),
# APPROVAL_SECRET and SECRETS_KEY, each with: openssl rand -hex 32
# No model key? Set MODEL_MODE=fake (and VOICE_MODE=fake).

pnpm build          # the framework, the application and the basecamp command
pnpm infra:up       # Postgres, Redis, MinIO, Mailpit, pgAdmin, LiveKit, WhatsApp emulator
pnpm db:migrate     # the framework's migrations, then the application's
pnpm templates:sync # register the WhatsApp templates with the emulator
pnpm dev            # API, worker, app, back office, voice worker and Mastra Studio
```

The `framework/cli/infra/postgres/init.sql` script runs automatically the first time the
Postgres container starts. It enables PostGIS and pgcrypto and fixes the `app` role's search path.

### Local addresses

| Service | URL |
|---|---|
| App (Expo web) | http://localhost:8081 |
| Back office | http://localhost:8082 |
| API | http://localhost:3000 (health at `/health`) |
| Queues (Bull Board, development only, for platform operators: `pnpm --dir application exec basecamp operator add <email>`) | http://localhost:3000/admin/queues |
| Mastra Studio | http://localhost:4000 (started by `pnpm dev` once the API is up) |
| WhatsApp emulator (whaloc) | http://localhost:8080 |
| Mailpit | http://localhost:8025 |
| pgAdmin | http://localhost:5050 |
| MinIO console | http://localhost:9001 |
| LiveKit | ws://localhost:7880 |

whaloc stands in for Meta's WhatsApp Cloud API. The adapter only knows a Graph URL, so moving
to Meta is a matter of configuration (`WA_GRAPH_URL`, the account ids and the tokens).

### Native apps

```bash
pnpm --filter @application/mobile ios       # or android
```

To use voice from a phone on the same Wi-Fi, set `LIVEKIT_NODE_IP` to your machine's LAN IP.
Maestro flows for the demo moments are in `application/mobile/maestro/`.

### Starting a new application

The same thing, from npm, without this repository (once the packages are published):

```bash
npm create @hykr/basecamp my-app      # or: pnpm create @hykr/basecamp my-app
cd my-app && pnpm install && cp .env.example .env
pnpm exec basecamp infra up && pnpm -r build && pnpm exec basecamp db migrate
pnpm exec basecamp dev
```

It starts from the sample domain in `application/`; replace it with yours. **[Build a new
application](docs/new-application.md)** walks through it end to end with a small repair
business, and [DOMAIN.md](DOMAIN.md) is the reference for each layer. CI scaffolds an
application this way from the packed packages on every push.

## Try it

Sign up in the app, then try these with the assistant:

- "Add a site review meeting tomorrow at 10."
- Open a meeting, paste your notes and say "close this one". The assistant drafts a summary
  note and one to-do per action item, then parks the whole close for your approval.
- "Move the site review to Friday." Its open to-dos move with it.
- "Delete the cement to-do." The assistant never deletes without you, so this waits for
  approval.
- Ask for a list, then say "save this as a page" to keep it on the canvas.
- Switch to voice mode and ask in Hindi or Telugu.
- "orders by status": totals from the orders' summary, never a list added up by the model.
- Message the demo number in the WhatsApp emulator.

Then check History in the app, the `audit.events` table, or the run in Mastra Studio to see
exactly what was called, parked and refused.

## Defining an entity

An entity lives in a module (`application/domain/src/modules/<name>/`): one spec in its
`contracts/`, a table in its `db/schema.ts`, and a Nest module in its `server/` that wires it up.
For example, the sample to-do, in the `todos` module:

```ts
export const TodoSpec = entitySpec({
  name: 'todo',
  label: 'to-do',
  schemas: { read: Todo, create: CreateTodoInput, update: UpdateTodoInput },
  fieldLabels: { title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' }, /* … */ },
  list: {
    filterable: { done: 'boolean', dueOn: 'date', meetingId: 'id', title: 'text' },
    sortable: ['dueOn', 'createdAt', 'title'],
    search: ['title'],
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'todo.list', item: 'todo.item' },
});
```

From the declaration alone you get:

- REST routes with filters, search, sort, keyset pages, counts and totals, and validation
- agent tools (`list-*`, `summarize-*`, `get-*`, `create-*`, `update-*`, `delete-*`, plus one per
  command), with approvals where the spec asks for them
- app hooks (`useEntityList`, `useEntity`, mutations, commands), and cache refresh after the
  assistant writes
- history, approval cards, and how tool results look in the app, on WhatsApp and in speech

The application is a list of modules, which teams can build in parallel. It hands them to the
framework in two places: the server (`application/api/src/server.ts`) and the app
(`application/mobile/src/app/_layout.tsx`):

```ts
// application/domain/src/modules/todos/index.ts
export const todos = defineModule({
  ...todosSpec,           // moduleSpec({ name: 'todos', dependsOn, entities, commands })
  server: TodosModule,    // the Nest module with defineEntity / defineCommand
  views: todosViews.views, // defineView / defineScreen
  templates, notifications,
  agent: todosAgent,      // rules, scripts, eval cases
  tables,                 // its db/schema.ts
});

// application/api/src/server.ts
export const server = defineServer({
  name: 'Meetings',
  persona: 'You are a meetings assistant. …',
  languages,              // defineLanguages(...): English, Hindi and Telugu in the sample
  channel: { does: { en: 'I can add, list and complete your to-dos and meetings.', … } },
  modules,                // [todos, notes, meetings, orders, account, briefs], in dependency order
  migrations: [migrations],
  contributes,            // what no one module owns: approval levels, privacy policy
});
```

`defineServer` refuses modules that collide (an entity, route, tool, view, template or table
declared twice, or one the framework has) and lists every problem. `basecamp module add <name>`
writes a new module; [Working on modules in parallel](docs/modules.md) is the procedure for
several people building modules at once.

## Replacing the domain

The sample's modules (meetings, notes, to-dos, orders, briefs and account) live in `application/`;
nothing in `framework/` names them. To build a real product, replace the modules in
`application/domain/src/modules` and their screens in `application/mobile`, or start fresh with
`npm create @hykr/basecamp`.

**[DOMAIN.md](DOMAIN.md)** covers:

- every folder to replace and what each must export
- who sees what (roles, `access` and assurance)
- the WhatsApp templates and notifications a domain adds
- the labels it needs for voice and languages
- what the framework already provides

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Watch-build the framework, and `basecamp dev` for the application |
| `pnpm build` / `typecheck` / `test` | Build, typecheck or test all workspaces (Turborepo) |
| `pnpm lint` / `format` | Biome check, or check and fix |
| `pnpm lint:deps` | dependency-cruiser boundary rules (framework and application, modules) |
| `pnpm lint:boundary` | Fails on product vocabulary in `framework/` (`scripts/check-boundary.sh`) |
| `pnpm infra:up` / `infra:down` | Start or stop the Docker Compose services |
| `pnpm db:generate --name <n>` / `db:migrate` | Generate the application's migration, or apply the framework's and the application's |
| `pnpm templates:sync` / `templates:check` | Send WhatsApp templates for review, or check they're approved |
| `pnpm eval` | Scripted assistant eval of every module (the API must be running) |
| `scripts/consumer.sh [--run] [<dir>]` | CI's `consumer` job: pack the framework, scaffold an app with it, install, build and typecheck; `--run` migrates it, starts its API and runs every eval suite |

Inside `application/` (or any application), the `basecamp` command does the rest
(`pnpm exec basecamp --help`; from the root, `pnpm --dir application exec basecamp …`):

| Command | What it does |
|---|---|
| `basecamp dev` | Compile the application in watch mode; run the API, worker, voice worker, apps and Studio |
| `basecamp start api\|worker\|voice` | Run one process |
| `basecamp infra up\|down` | The local services |
| `basecamp db migrate` / `db generate [--name n]` | Migrations |
| `basecamp db rebase [--base b] [--name n]` | After a rebase: drop this branch's migrations and generate them again on top of the base's |
| `basecamp module add <name> [--entity e]` | A new module, both halves, and the lines that register it |
| `basecamp import <entity> <file> --as <email> [--dry-run]` | Import a CSV, JSON or NDJSON file of records through the write path |
| `basecamp templates sync\|check` | WhatsApp templates at the provider |
| `basecamp operator add\|remove\|list` | Platform operators |
| `basecamp eval [assistant\|voice\|whatsapp] [--module m] [--live [--model ref]]` | Score the assistant, every module's evals or one module's |
| `basecamp studio` | Mastra Studio on its own, with the API running (`basecamp dev` starts it too) |

## Testing

- **Unit tests:** Vitest in each package.
- **Framework end-to-end tests:** `framework/api/test/framework` boots the compiled API on a
  random port against real Postgres and Redis, with the scripted model, on a small fixture
  application (`framework/api/test/fixture`: tasks and visits). They need no application.
- **Application end-to-end tests:** `application/api/test` boots the application's server the
  same way, through `@hykr/api/testing`.
- **Golden WhatsApp conversations:** `application/api/test/whatsapp`, against a separate
  emulator, `whaloc-test` on port 8090.
- **Evals:** scored per turn on tool use, refusals, answer language and spoken length, per
  module (`basecamp eval --module <name>`) or for every module.
- **CI:** `.github/workflows/ci.yml` runs lint, `lint:boundary`, build, typecheck, `lint:deps`,
  migrations and tests on every push and pull request, using the scripted model so no keys are
  needed. A second job packs every `@hykr/*` package, scaffolds an application with
  `create-basecamp`, installs it from the tarballs and builds it.

## Documentation

- [Developer guide](docs/developer-guide.md): how the pieces fit, every primitive with its
  recipe, the rules, testing, the definition of done, and what is not built yet (section 14).
- [Build a feature end to end](docs/tutorial.md): site visits added to the sample, through every
  layer.
- [Build a new application](docs/new-application.md): a new product from scratch.
- [Working on modules in parallel](docs/modules.md): module add, boundaries, the one migration
  journal, per-module tests and evals.
- [DOMAIN.md](DOMAIN.md): what each module and application layer exports.
- `docs/decisions/`: the decisions and open questions of each unit of work.

## Notes

- `MODEL_MODE=fake` runs the real agent loop on a scripted model, with no network and no
  cost. Tests, CI and offline demos use it.
- OpenRouter is for development. In production, `MODEL_PROVIDERS` names the deployment's own
  gateways and each business's model policy chooses among them (developer guide 7.5).
- The sample content is placeholder data with a construction-site flavour (tiles, cement,
  site reviews). It is not real customer evidence.
