# Basecamp

**The agentic development stack for full-stack applications.**

Basecamp is a starting point for products where an AI assistant works alongside people, with
the same rules, approvals and audit trail as everyone else.

You declare a business entity once. From that declaration it gets a REST API, agent tools,
app screens and data hooks, approval cards, history, and WhatsApp and voice support, with no
hand-written plumbing. The template ships with a sample domain (meetings, notes and to-dos)
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
| **API** | NestJS, CQRS, Better Auth, Drizzle on Postgres (PostGIS), Redis rate limiting, BullMQ queues |
| **Assistant** | Mastra agents through OpenRouter, a scripted model for offline runs, Studio, tracing and evals |
| **App** | Expo (web, iOS, Android) with Expo Router, assistant-ui, TanStack Query, Uniwind and React Native Reusables |
| **Agent-driven UI** | Tool results carry a view and a query, not data. The client renders them inline or on a canvas, and saved pages hold queries |
| **Voice** | LiveKit plus a voice worker using Sarvam speech-to-text and text-to-speech, in English, Hindi and Telugu |
| **WhatsApp** | Cloud API adapter, signed webhooks, consent and keywords, templates as code, approvals by button, handoff to a back office |
| **Tenancy** | Businesses, memberships with roles (`owner`, `admin`, `ops`, `staff`, `customer`) and customers, with a scope engine behind each entity's `access` |
| **Tooling** | pnpm workspaces, Turborepo, Biome, dependency-cruiser, Vitest, Maestro, GitHub Actions |

## Repository layout

```
apps/
  api/            NestJS API and queue worker (REST, chat, voice sessions, WhatsApp webhook, back office API)
  mobile/         Expo app: entity screens, the assistant, canvas, pages, voice mode
  back-office/    Expo web app where staff pick up conversations handed off from WhatsApp
  voice-worker/   LiveKit agent: speech in, a chat turn for the person, speech and UI parts out
packages/
  contracts/      Entity and command specs (Zod), the domain catalog, shared types
  core/           defineEntity / defineCommand, the write path, list grammar, generated tools
  db/             Drizzle schema and migrations
  policy/         authorize(): who may do what
  agents/         The assistant (Mastra), scripted model, scorers, evals, Studio
  api-client/     Typed client used by the app, the agents and the voice worker
  ui-registry/    defineView / defineScreen: what tool results render as, in text, speech and UI
  channels/       WhatsApp adapter, renderer, keywords, signed approval tokens
  notifications/  Templates and notifications as code, and dispatch rules
  i18n/           Framework phrases and date and count words in en, hi and te
infra/            Postgres init and pgAdmin config
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
cp .env.example .env
# Fill in BETTER_AUTH_SECRET, AGENT_API_KEY, VOICE_AGENT_KEY and APPROVAL_SECRET:
#   openssl rand -hex 32
# No model key? Set MODEL_MODE=fake (and VOICE_MODE=fake).

pnpm infra:up       # Postgres, Redis, MinIO, Mailpit, pgAdmin, LiveKit, WhatsApp emulator
pnpm build
pnpm db:migrate
pnpm templates:sync # register the WhatsApp templates with the emulator
pnpm dev            # API, worker, app, back office and voice worker
```

The `infra/postgres/init.sql` script runs automatically the first time the Postgres container
starts. It enables PostGIS and pgcrypto and fixes the `app` role's search path.

### Local addresses

| Service | URL |
|---|---|
| App (Expo web) | http://localhost:8081 |
| Back office | http://localhost:8082 |
| API | http://localhost:3000 (health at `/health`) |
| Queues (Bull Board, development only) | http://localhost:3000/admin/queues |
| Mastra Studio | http://localhost:4000 (`pnpm --filter @app/agents studio`, with the API running) |
| WhatsApp emulator (whaloc) | http://localhost:8080 |
| Mailpit | http://localhost:8025 |
| pgAdmin | http://localhost:5050 |
| MinIO console | http://localhost:9001 |
| LiveKit | ws://localhost:7880 |

whaloc stands in for Meta's WhatsApp Cloud API. The adapter only knows a Graph URL, so moving
to Meta is a matter of configuration (`WA_GRAPH_URL`, the account ids and the tokens).

### Native apps

```bash
pnpm --filter @app/mobile ios       # or android
```

To use voice from a phone on the same Wi-Fi, set `LIVEKIT_NODE_IP` to your machine's LAN IP.
Maestro flows for the demo moments are in `apps/mobile/maestro/`.

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
- Message the demo number in the WhatsApp emulator.

Then check History in the app, the `audit.events` table, or the run in Mastra Studio to see
exactly what was called, parked and refused.

## Defining an entity

An entity is one spec in `packages/contracts` plus a table and a module that wires it up.
For example, the sample to-do:

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

- REST routes with filters, search, sort, keyset pages, validation and OpenAPI shapes
- agent tools (`list-*`, `get-*`, `create-*`, `update-*`, `delete-*`, plus one per command),
  with approvals where the spec asks for them
- app hooks (`useEntityList`, `useEntity`, mutations, commands), and cache refresh after the
  assistant writes
- history, approval cards, and how tool results look in the app, on WhatsApp and in speech

## Replacing the domain

Meetings, notes and to-dos live in one `domain/` folder per layer. The framework reads each
folder only through its `index`, and `pnpm lint:deps` enforces that boundary. To build a real
product, replace those folders and nothing else changes.

**[DOMAIN.md](DOMAIN.md)** covers:

- every folder to replace and what each must export
- who sees what (roles, `access` and assurance)
- the WhatsApp templates and notifications a domain adds
- the labels it needs for voice and languages
- what the framework already provides

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run every app in watch mode |
| `pnpm build` / `typecheck` / `test` | Build, typecheck or test all workspaces (Turborepo) |
| `pnpm lint` / `format` | Biome check, or check and fix |
| `pnpm lint:deps` | dependency-cruiser boundary rules |
| `pnpm infra:up` | Start the Docker Compose services |
| `pnpm db:generate` / `db:migrate` | Generate or apply Drizzle migrations |
| `pnpm templates:sync` / `templates:check` | Send WhatsApp templates for review, or check they're approved |
| `pnpm --filter @app/agents eval` | Scripted assistant eval (`eval:voice`, `eval:whatsapp`, and `:live` variants) |
| `pnpm --filter @app/agents studio` | Mastra Studio for the assistant |

## Testing

- **Unit tests:** Vitest in each package.
- **End-to-end tests:** `apps/api/test` boots the compiled API on a random port against real
  Postgres and Redis, with the scripted model. Framework tests use only platform features or
  fixture entities, so they pass with any domain.
- **Golden WhatsApp conversations:** run against a separate emulator, `whaloc-test` on port
  8090.
- **Evals:** scored per turn on tool use, refusals, answer language and spoken length.
- **CI:** `.github/workflows/ci.yml` runs lint, build, typecheck, `lint:deps`, migrations and
  tests on every push and pull request, using the scripted model so no keys are needed.

## Notes

- `MODEL_MODE=fake` runs the real agent loop on a scripted model, with no network and no
  cost. Tests, CI and offline demos use it.
- OpenRouter sends data outside India. Use it for development only.
- The sample content is placeholder data with a construction-site flavour (tiles, cement,
  site reviews). It is not real customer evidence.
