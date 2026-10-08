# The domain is replaceable

Basecamp, the agentic development stack for full-stack applications, ships with a sample domain: meetings, notes and to-dos. Everything else is the
framework: the API pipeline (rules, approvals, audit), the assistant (tools, surfaces, the
canvas, WhatsApp), saved pages, and the app shell. The domain lives in one folder per layer,
and the framework reads each folder only through its `index`. A dependency-cruiser rule
(`framework-reads-the-domain-through-its-index`, run by `pnpm lint:deps`) enforces the
boundary.

New here? Read the [developer guide](docs/developer-guide.md), then build a feature with the
[tutorial](docs/tutorial.md).

To bring another domain, replace these folders. Nothing outside them changes.

| Layer | Delete and replace | It must export |
|---|---|---|
| Contracts | `packages/contracts/src/domain/` | `domain = defineDomain({ name, entities, commands })`, with entities keyed by plural (`entitySpec`) and commands (`commandSpec`) |
| Database | `packages/db/src/schema/domain.ts` | Drizzle tables in the `app` schema, each with `id`, `tenantColumn()`, an owner column, `customerColumn()` (when customers have rows), `createdBy`, `createdAt`, `updatedAt` |
| API | `apps/api/src/domain/` | `DomainModule`: one `defineEntity` / `defineCommand` per spec, each in a Nest module with `entityController` / `entityHandlers` / `commandController`; who sees what in `access` (see below) |
| Notifications | `packages/notifications/src/domain/` | `domainTemplates` (`defineTemplate`) and `domainNotifications` (`defineNotification`): the WhatsApp templates and the reminders the domain sends |
| Views | `packages/ui-registry/src/domain/` | `uiDomain = { views, screens }`, declared with `defineView` / `defineScreen` |
| Assistant | `packages/agents/src/domain/` | `agentDomain: AgentDomain`: persona, domain rules, the scripted model's scripts and help, eval cases (and spoken `voiceEvalCases`) and setup |
| App | `apps/mobile/src/domain/` | `appDomain = defineAppDomain({ tagline, nav, suggestions, bind })`; `bind` calls `bindView` / `bindScreen` for the domain's views and screens |
| App routes | `apps/mobile/src/app/(domain)/` | The domain's screens; the group adds no URL segment. Provide `index.tsx` (the home screen) |
| Tests | `apps/api/test/domain/`, `packages/ui-registry/src/domain/*.test.ts` | The domain's own e2e and view tests |

Then:

1. `pnpm --filter @app/db generate --name <domain>` and `pnpm db:migrate` for the new tables.
2. `pnpm templates:sync` sends the new templates for review; `pnpm templates:check` passes once
   every template a notification uses is approved in English.
3. `pnpm turbo run build typecheck test`, `pnpm lint`, `pnpm lint:deps`, `pnpm --filter @app/agents eval`,
   `eval:voice` and `eval:whatsapp`.

## Who sees what: businesses, roles and customers

Every row belongs to a business (a tenant) and is read and written only inside it. A person can
hold several roles in a business: `owner`, `admin`, `ops`, `staff`, `customer`. An entity's
`access` says what each role reaches, per read and write:

- `own`: rows the person owns; `customer`: rows of the customer they are; `tenant`: every row
  in the business.
- A write may need `minAssurance: 'session'`: a WhatsApp number alone (`whatsapp_number`) is
  refused with `needs_assurance`.

The sample domain gives the owner and staff their own rows, admin and ops the whole business,
and a customer their own customer's rows (`apps/api/src/domain/access.ts`). With
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

Voice is a framework channel (the worker in `apps/voice-worker` calls `/api/chat` like the
app). The product speaks English, Hindi and Telugu (`@app/i18n`); a domain brings its own
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
  (`/api/voice/*`, LiveKit, the voice worker), and the framework's phrases in `@app/i18n`.
- Businesses, memberships and customers (`/api/me`), and the scope engine behind `access`.
- The WhatsApp channel (`apps/api/src/channels`, `packages/channels`): the webhook, the queues
  (`/admin/queues` in development) and the worker, contacts and linking by code, consent and the
  keywords (STOP, START, HELP, talk to a person, delete my data) in every language, erasure,
  voice notes, approvals by signed button, and handoff to a person with the back office
  (`apps/back-office`, `/api/backoffice`).
- The framework's templates and notifications: login codes, approval requests and outcomes,
  staff replies after the 24-hour window. The agent tools `send-template` (a template to a
  customer; marketing waits for approval) and `request-human`.
- The streaming chat, and the scripted model's platform scripts (`save this as …`,
  `open my … page`, `talk to the manager`, the back office's draft reply).
- The framework's tests (`apps/api/test/framework`, `packages/*/src/**/*.test.ts` outside
  `domain/`). They use only those platform features or fixture entities, so they pass with
  any domain. The golden WhatsApp conversations (`apps/api/test/whatsapp`) run against
  whaloc-test and use the sample domain's words: replace them with the domain.
