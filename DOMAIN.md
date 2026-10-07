# The domain is replaceable

This template ships with a sample domain: meetings, notes and to-dos. Everything else is the
framework: the API pipeline (rules, approvals, audit), the assistant (tools, surfaces, the
canvas, WhatsApp), saved pages, and the app shell. The domain lives in one folder per layer,
and the framework reads each folder only through its `index`. A dependency-cruiser rule
(`framework-reads-the-domain-through-its-index`, run by `pnpm lint:deps`) enforces the
boundary.

To bring another domain, replace these folders. Nothing outside them changes.

| Layer | Delete and replace | It must export |
|---|---|---|
| Contracts | `packages/contracts/src/domain/` | `domain = defineDomain({ name, entities, commands })`, with entities keyed by plural (`entitySpec`) and commands (`commandSpec`) |
| Database | `packages/db/src/schema/domain.ts` | Drizzle tables in the `app` schema, each with `id`, an owner column, `createdBy`, `createdAt`, `updatedAt` |
| API | `apps/api/src/domain/` | `DomainModule`: one `defineEntity` / `defineCommand` per spec, each in a Nest module with `entityController` / `entityHandlers` / `commandController` |
| Views | `packages/ui-registry/src/domain/` | `uiDomain = { views, screens }`, declared with `defineView` / `defineScreen` |
| Assistant | `packages/agents/src/domain/` | `agentDomain: AgentDomain`: persona, domain rules, the scripted model's scripts and help, eval cases and setup |
| App | `apps/mobile/src/domain/` | `appDomain = defineAppDomain({ tagline, nav, suggestions, bind })`; `bind` calls `bindView` / `bindScreen` for the domain's views and screens |
| App routes | `apps/mobile/src/app/(domain)/` | The domain's screens; the group adds no URL segment. Provide `index.tsx` (the home screen) |
| Tests | `apps/api/test/domain/`, `packages/ui-registry/src/domain/*.test.ts` | The domain's own e2e and view tests |

Then:

1. `pnpm --filter @app/db generate --name <domain>` and `pnpm db:migrate` for the new tables.
2. `pnpm turbo run build typecheck test`, `pnpm lint`, `pnpm lint:deps`, `pnpm --filter @app/agents eval`.

## What comes for free

From the contracts declaration alone:

- REST routes with the list grammar (filters, search, sort, keyset pages), validation and
  OpenAPI shapes.
- Agent tools (`list-*`, `get-*`, `create-*`, `update-*`, `delete-*`, one per command), with
  approvals where the spec asks for them.
- The app's data hooks (`useEntityList`, `useEntity`, mutations, commands) and
  query-cache refresh after the assistant writes (commands declare `touches`).
- History for every entity (`GET /api/history`), approval cards and history lines worded from
  each command's `verb`.
- Present intents: an entity spec's `views` (and a command's `view`) choose what its tool
  results show. On WhatsApp and voice they are rendered to words with the views' `text` /
  `speak`.

## What the framework owns, in every domain

- Saved canvas pages (`pages`), the canvas tools, and the views `approval.card`, `kpi.row`,
  `page.list` and the screen `page.view`.
- The WhatsApp channel, the streaming chat, and the scripted model's platform scripts
  (`save this as …`, `open my … page`).
- The framework's tests (`apps/api/test/framework`, `packages/*/src/**/*.test.ts` outside
  `domain/`). They use only those platform features or fixture entities, so they pass with
  any domain.
