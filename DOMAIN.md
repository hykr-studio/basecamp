# The domain is replaceable

Basecamp, the agentic development stack for full-stack applications, ships with a sample
application: meetings, notes and to-dos. The framework (the API pipeline with its rules,
approvals and audit; the assistant with its tools, surfaces, canvas and WhatsApp; saved pages;
the app shell) lives in `framework/` and is published as `@hykr/*` packages. The application
lives in `application/`. The framework never imports the application; the application hands
its domain to the framework in two places:

- the server: `application/api/src/server.ts`, `defineServer({ domain, module, views,
  notifications, agent, channel, migrations })` from `@hykr/api`;
- the app: `application/mobile/src/app/_layout.tsx`, `<AppShell app catalog registry config />`
  from `@hykr/app`.

Two dependency-cruiser rules, run by `pnpm lint:deps`, keep it that way:
`framework-never-imports-application` and `application-uses-public-framework-exports` (only
`@hykr/*` package exports, never a path into `framework/`).

New here? Read the [developer guide](docs/developer-guide.md), then build a feature with the
[tutorial](docs/tutorial.md). To start an application outside this repository, run
`npm create @hykr/basecamp <folder>`: you get a copy of `application/` on the published
packages.

To bring another domain, replace these folders. Nothing in `framework/` changes.

| Layer | Delete and replace | It must export |
|---|---|---|
| Contracts | `application/domain/src/contracts/` | `domain = defineDomain({ name, entities, commands })`, with entities keyed by plural (`entitySpec`) and commands (`commandSpec`) |
| Database | `application/domain/src/db/schema.ts` and `application/domain/drizzle/` | Drizzle tables in the `app` schema (`app`, `id`, `tenantColumn()`, `customerColumn()` and `user` come from `@hykr/db`), each with `id`, `tenantColumn()`, an owner column, `customerColumn()` (when customers have rows), `createdBy`, `createdAt`, `updatedAt`; and the migrations generated from them |
| API | `application/domain/src/server/` | `DomainModule`: one `defineEntity` / `defineCommand` per spec, each in a Nest module with `entityController` / `entityHandlers` / `commandController`; who sees what in `access` (see below) |
| Notifications | `application/domain/src/notifications/` | `domainTemplates` (`defineTemplate`) and `domainNotifications` (`defineNotification`): the WhatsApp templates and the reminders the domain sends |
| Views | `application/domain/src/views/` | `uiDomain = { views, screens }`, declared with `defineView` / `defineScreen` |
| Assistant | `application/domain/src/agent/` | `agentDomain: AgentDomain` (`@hykr/agents/script`): persona, domain rules, the scripted model's scripts and help, eval cases (and spoken `voiceEvalCases`) and setup |
| Server | `application/api/src/server.ts` | `server = defineServer({ ... })`, with the pieces above and `channel.does`: what the assistant helps with, in each language (WhatsApp's welcome and HELP) |
| App | `application/mobile/src/domain/` | `appDomain = defineAppDomain({ title, tagline, nav, home, suggestions, bind })` from `@hykr/app`; `bind` calls `bindView` / `bindScreen` for the domain's views and screens; `catalog` and `registry` built with `createCatalog` / `createUiRegistry` |
| App routes | `application/mobile/src/app/(domain)/` | The domain's screens; the group adds no URL segment. Provide `index.tsx` (the home screen) |
| Tests | `application/api/test/`, `application/domain/src/**/*.test.ts` | The domain's own e2e, WhatsApp, voice, view and notification tests |

Then:

1. `pnpm db:generate --name <domain>` (or `basecamp db generate`) and `pnpm db:migrate` for
   the new tables: the framework's migrations run first, then the application's.
2. `pnpm templates:sync` sends the new templates for review; `pnpm templates:check` passes once
   every template a notification uses is approved in English.
3. `pnpm turbo run build typecheck test`, `pnpm lint`, `pnpm lint:deps`, and with the API
   running, `basecamp eval`, `basecamp eval voice` and `basecamp eval whatsapp`.

## Who sees what: businesses, roles and customers

Every row belongs to a business (a tenant) and is read and written only inside it. A person can
hold several roles in a business: `owner`, `admin`, `ops`, `staff`, `customer`. An entity's
`access` says what each role reaches, per read and write:

- `own`: rows the person owns; `customer`: rows of the customer they are; `tenant`: every row
  in the business.
- A write may need `minAssurance: 'session'`: a WhatsApp number alone (`whatsapp_number`) is
  refused with `needs_assurance`.

The sample domain gives the owner and staff their own rows, admin and ops the whole business,
and a customer their own customer's rows (`application/domain/src/server/access.ts`). With
`customer: (t) => t.customerId`, a customer's assistant creates rows for that customer, owned by
the business's default owner.

Approvals take an object form, `{ when, by, channels, minAssurance }`: who decides (the person
it is for by default; a customer's request goes to `owner` and `ops`), and where (`channels:
['app']` for anything irreversible keeps it off WhatsApp buttons).

## What a domain adds for WhatsApp: templates and notifications

Outside a customer's 24-hour window WhatsApp delivers only approved templates, so everything a
domain sends on its own initiative is a template, declared in code:

- **`defineTemplate`:** a versioned name (`meeting_reminder_v1`), a category, named parameters
  with an example each, the body in every language, at most three quick replies. An approved
  template is never edited: changing the words fails `templates:sync` with "bump the version".
- **`defineNotification`:** what reaches whom, and when. `schedule: { on, at, cancelOn }`
  follows the entity events (`meeting.created`, `meeting.deleted`) and the domain's own: a
  command's event implements `NamedEvent` (`eventName`, `row`) to be one. `to` names the
  recipients (a user, a customer, a contact, or everyone with a role); `channels` is the order
  to try (`['whatsapp', 'email']`); `onButton` answers its quick replies (snooze).
- The framework decides the rest per recipient: consent for the topic, quiet hours and the
  marketing cap (per business), the template in their language or English, and the next
  channel when WhatsApp can't be used or fails for good. No domain code sends a message.

## What a domain adds for voice and languages

Voice is a framework channel (the worker in `framework/voice-worker` calls `/api/chat` like the
app). The product speaks English, Hindi and Telugu (`@hykr/i18n`); a domain brings its own
words, each as `Labels` (`{ en, hi, te }`, so a missing translation does not compile):

- **Views:** `labels: { title, empty, noun }`. A list view that can be spoken must have
  `noun` and `empty` (the registry refuses it otherwise); `speak(props, { lang })` returns the
  short spoken form, usually `spokenList(...)`. Components get `words` (title and empty line
  in the person's language) from the renderer.
- **Entities:** `fieldLabels`: what the approval preview calls each field, in the person's language.
- **Scripted model:** the domain's verbs in each language (`verbs(...)`, before or after the
  title), answers through `sayIn(turn, { en, hi, te })`, and `written(..., turn)` for writes.
- **Evals:** `voiceEvalCases`, scored on the tools, the answer's language and its length.
  `eval:whatsapp` replays the Hindi and Telugu ones as typed WhatsApp messages.

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
  results show. On WhatsApp they are rendered to words with the views' `text`; on a voice
  turn the view is shown and its `speak` form, in the turn's language, is given to the model.

## What the framework owns, in every domain

- Saved canvas pages (`pages`), the canvas tools, and the views `approval.card`, `kpi.row`,
  `page.list` and the screen `page.view`.
- Threads (one saved conversation per person, shared by every channel), voice sessions
  (`/api/voice/*`, LiveKit, the voice worker), and the framework's phrases in `@hykr/i18n`.
- Businesses, memberships and customers (`/api/me`), and the scope engine behind `access`.
- The WhatsApp channel (`framework/api/src/channels`, `framework/channels`): the webhook, the queues
  (`/admin/queues` in development) and the worker, contacts and linking by code, consent and the
  keywords (STOP, START, HELP, talk to a person, delete my data) in every language, erasure,
  voice notes, approvals by signed button, and handoff to a person with the back office
  (`framework/back-office`, `/api/backoffice`).
- The framework's templates and notifications: login codes, approval requests and outcomes,
  staff replies after the 24-hour window. The agent tools `send-template` (a template to a
  customer; marketing waits for approval) and `request-human`.
- The streaming chat, and the scripted model's platform scripts (`save this as …`,
  `open my … page`, `talk to the manager`, the back office's draft reply).
- The framework's tests (`framework/api/test/framework` and `framework/*/src/**/*.test.ts`).
  They use only those platform features and a fixture application of their own
  (`framework/api/test/fixture`), so they pass with no application at all. The golden WhatsApp
  conversations (`application/api/test/whatsapp`) run against whaloc-test and use the sample
  domain's words: replace them with the domain.
