# The domain is replaceable

Basecamp, the agentic development stack for full-stack applications, ships with a sample
application: meetings, notes, to-dos and orders, as four modules. The framework (the API pipeline with
its rules, approvals and audit; the assistant with its tools, surfaces, canvas and WhatsApp;
saved pages; the app shell) lives in `framework/` and is published as `@hykr/*` packages. The
application lives in `application/`. The framework never imports the application; the
application hands its modules to the framework in two places:

- the server: `application/api/src/server.ts`, `defineServer({ name, persona, help, channel,
  modules, migrations, contributes })` from `@hykr/api`;
- the app: `application/mobile/src/app/_layout.tsx`, `<AppShell app modules plugins catalog
  registry config />` from `@hykr/app`, with the app's modules (`defineAppModule`), the framework
  plugins it uses (`livePlugin()`, `pushPlugin()`, and `webMcpPlugin()`, which offers each screen's
  `webmcp` read tools to a browser agent), and the catalog and registry built from every module's
  specs and views.

Two dependency-cruiser rules, run by `pnpm lint:deps`, keep it that way:
`framework-never-imports-application` and `application-uses-public-framework-exports` (only
`@hykr/*` package exports, never a path into `framework/`).

New here? Read the [developer guide](docs/developer-guide.md), then build a feature with the
[tutorial](docs/tutorial.md); to build a new product from scratch, follow
[Build a new application](docs/new-application.md). To start an application outside this repository, run
`npm create @hykr/basecamp <folder>`: you get a copy of `application/` on the published
packages.

## Modules

An application is a list of modules. A module is a folder,
`application/domain/src/modules/<name>/`, that teams can build in parallel. Its name is lower
case (`orders`); it prefixes the module's tables, and every spec it declares is stamped with it
(`spec.module`, `catalog.moduleOf`). `basecamp module add <name>` writes a new one, both halves,
and registers it.

| Layer | In the module | It must export |
|---|---|---|
| Contracts | `contracts/` (isomorphic) | Its `entitySpec`s and `commandSpec`s, and `<name>Spec = moduleSpec({ name, dependsOn, entities, commands })` from `@hykr/contracts`, entities keyed by plural. A field that keeps files is a `FileRef` or `fileRefs(max)`, listed in the spec's `files` trait with what it accepts |
| Database | `db/schema.ts` | Drizzle tables in the `app` schema (`app`, `id`, `tenantColumn()`, `customerColumn()`, `user`, `tableRef` from `@hykr/db`), named after the module (`orders`, `orders_lines`), each with `id`, `tenantColumn()`, an owner column, `customerColumn()` (when customers have rows), `createdBy`, `createdAt`, `updatedAt`. A file field's column is `fileColumn(<field>)` or `fileColumns(<field>)` |
| API | `server/` | A Nest module with one `defineEntity` / `defineCommand` per spec (`entityController` / `entityHandlers` / `commandController`); who sees what in `access` (see below). `server/public.ts`: what other modules may call |
| Notifications | `notifications/` (isomorphic) | Its templates (`defineTemplate`) and notifications (`defineNotification`) |
| Views | `views/` (isomorphic) | `<name>Views = { name, views, screens }`, declared with `defineView` / `defineScreen` |
| Assistant | `agent/` | An `AgentModule` (`@hykr/agents/script`): its rules, the scripted model's scripts, eval cases (and spoken `voiceEvalCases`) and setup |
| Bundle | `index.ts` (server only) | `<name> = defineModule({ ...<name>Spec, server, views, screens, templates, notifications, agent, tables })` from `@hykr/api` |

Around the modules, the application keeps:

| Layer | Path | It must export |
|---|---|---|
| Modules list | `application/domain/src/modules/index.ts` | `modules`, in dependency order (a module after the modules it depends on), one line per module |
| Aggregates for the apps | `application/domain/src/contracts/index.ts`, `src/views/index.ts` | Every module's specs and views (`moduleSpecs`, `moduleViews`), one line per module. The apps import `@application/domain/contracts` and `/views`, or one module's `@application/domain/modules/<name>/contracts` and `/views` |
| Migrations | `application/domain/drizzle/`, `src/db/index.ts` | One journal for every module, generated from `src/modules/*/db/schema.ts`; `migrations` |
| Shared server code | `application/domain/src/server/` | What several modules use, such as `BUSINESS_ACCESS` |
| Server | `application/api/src/server.ts` | `server = defineServer({ name, persona, help, channel, modules, migrations })`: what the product is called, who the assistant is, and `channel.does`: what it helps with, in each language (WhatsApp's welcome and HELP). Optionally `contributes`: hooks and plugins by kind, among them queues, schedules, event subscribers, turn hooks, tools and delivery channels (developer guide, sections 5.9 and 5.10), and the application's approval levels and level rules (section 5.8.1; the sample's are in `application/domain/src/server/approval-levels.ts`, passed through `@application/domain/server`) |
| App modules | `application/mobile/src/modules/<name>/` and the barrel `src/modules/index.ts` (one line per module) | The app half of each module: `defineAppModule({ name, nav, suggestions, bind, hrefFor, webmcp })` from `@hykr/app`, in `index.tsx`: destinations under `/<name>`; `bind` calls `bindView` / `bindScreen` for the module's views and screens; `hrefFor` says where each of its records opens. Other modules import only that `index.tsx` |
| App | `application/mobile/src/catalog.ts`, `settings.ts`, `home/` | `catalog = createCatalog(...moduleSpecs)` and `registry = createUiRegistry(...moduleViews)` with the `Register` declaration; `settings: AppSettings` (`title`, `tagline`, `home`, and the nav and suggestions of the screens that combine modules, such as the home screen) |
| App routes | `application/mobile/src/app/<name>/` and `src/app/index.tsx` | One-line re-exports of each module's route components (Expo Router only knows files); `index.tsx` is the home screen |
| Tests | `application/api/test/`, `application/domain/src/**/*.test.ts` | The application's own e2e, WhatsApp, voice, view and notification tests |

### How modules fit together

- **Dependencies.** A module lists the modules it builds on in `dependsOn`, and the modules list
  puts it after them. It imports another module only through that module's `contracts/` or its
  `server/public.ts` (`meetings` closes a meeting by writing a note and to-dos through
  `notes/server/public.ts` and `todos/server/public.ts`, in its own transaction). The
  dependency-cruiser rules `module-imports-public-parts`, `module-<name>-imports-its-dependencies`
  and `no-module-cycles` enforce it.
- **A foreign key down the graph.** A lower module's table that points at a higher module's
  (a note's `meeting_id`) names the table instead of importing it: `tableRef('meetings').id`.
- **No collisions.** `defineServer` merges the modules and checks, at boot, that no two of them
  (or a module and the framework) declare the same entity name or plural, command, tool id,
  route (`/api/approvals` and the framework's other routes are reserved), approval op, view,
  screen, template, notification key or table. It also checks what one part names in another
  (a spec's views, a view's actions, a notification's events) and that no module's script takes
  another module's eval turn. Every problem is listed in one error.
- **One assistant.** The application gives the persona and the help line; each module adds its
  rules and scripts, in module order (an earlier module's script matches first).
- **Evals per module.** `basecamp eval --module <name>` runs one module's evals, with a fresh user
  and that module's setup; without `--module`, every module's.
- **One journal.** `basecamp db generate --name <name>` writes the migration for every module's
  tables. After a rebase, `basecamp db rebase` drops your branch's migrations and generates them
  again on top of the base's.

To bring another domain, replace the modules. Nothing in `framework/` changes. Then:

1. `pnpm db:generate --name <domain>` (or `basecamp db generate`) and `pnpm db:migrate` for
   the new tables: the framework's migrations run first, then the application's.
   Extensions, triggers and CHECK constraints go in idempotent SQL hooks in
   `application/domain/sql/pre` and `sql/post`, which run around the migrations every time.
2. `pnpm templates:sync` sends the new templates for review; `pnpm templates:check` passes once
   every template a notification uses is approved in English.
3. `pnpm turbo run build typecheck test`, `pnpm lint`, `pnpm lint:deps`, and with the API
   running, `basecamp eval`, `basecamp eval voice` and `basecamp eval whatsapp` (each with
   `--module <name>` for one module).

## Who sees what: businesses, roles and customers

Every row belongs to a business (a tenant) and is read and written only inside it. A person can
hold several roles in a business. The framework registers `owner`, `admin`, `ops`, `staff` and
`customer`; a domain adds its own with `contributes: { roles, capabilities }` (developer guide
6.4). An entity's `access` says what each role reaches, per read and write:

- `own`: rows the person owns; `customer`: rows of the customer they are; `tenant`: every row
  in the business.
- A write may need `minAssurance: 'session'`: a WhatsApp number alone (`whatsapp_number`) is
  refused with `needs_assurance`.

The sample modules give the owner and staff their own rows, admin and ops the whole business,
and a customer their own customer's rows (`application/domain/src/server/access.ts`, shared by
the modules). With
`customer: (t) => t.customerId`, a customer's assistant creates rows for that customer, owned by
the business's default owner.

Anything else a role may do (a screen, a feature, a hidden field) is a capability: declare it
with `defineCapability({ name: '<area>.<action>', label, roles })` and check it with
`can(p, name)` from `@hykr/policy`, never by naming a role. `GET /api/me` lists the person's
capabilities for the apps.

Approvals take an object form, `{ when, by, channels, minAssurance, level }`: who decides (the
person it is for by default; a customer's request goes to holders of `approvals.decide`; `by`
names a capability, a person or an amount band, never a role), and where (`channels: ['app']` for
anything irreversible keeps it off WhatsApp buttons). Nobody decides their own request unless the
policy sends it back to them. What each approval level means (does it wait, who decides, how long
it can be undone) is the application's: the sample declares `read`, `internal`, `external` and
`irreversible` (`application/domain/src/server/approval-levels.ts`), and the to-dos module maps its
writes to `internal` with a level rule. Thresholds and approvers per amount band are each
business's settings (`approvals`).

## Money, numbers and lines

The framework has no currency, number format or tax rule of its own; a module declares them
(the sample's `orders` module does all three, developer guide 5.13):

- **Money** is whole minor units with an ISO 4217 currency (`Money = { minor, currency }`):
  `minorUnits()` and `currencyColumn()` columns and the spec's `money` trait. A business's
  currency is its `money.currency` setting, else the deployment's `DEFAULT_CURRENCY`, else `XXX`.
  Limits and bands a module's rules compare against are named amounts in the same settings.
- **Number series** (`defineNumberSeries`, contributed as `numberSeries`): the module's format
  (`ORD/{fy}/{seq:4}`) and reset (none, yearly, or the financial year from `fyStartMonth`);
  `nextNumber` in a command's `run` keeps them gapless. Numbered records are cancelled, never
  deleted.
- **Tax** is the module's function (`defineTaxFunction`); `applyTax` checks its lines and adds them up.
- **Lines** are a child entity (`traits.parent`, `defineChildEntity`): rows of one parent record,
  in a tree of any depth, reached exactly when the parent is, and saved whole by a command
  (`children.replace`) as one write, one approval and one audit statement.

## What a module adds for WhatsApp: templates and notifications

Outside a customer's 24-hour window WhatsApp delivers only approved templates, so everything a
module sends on its own initiative is a template, declared in code:

- **`defineTemplate`:** a versioned name (`meeting_reminder_v1`), a category, named parameters
  with an example each, the body in every language, at most three quick replies. An approved
  template is never edited: changing the words fails `templates:sync` with "bump the version".
- **`defineNotification`:** what reaches whom, and when. `schedule: { on, at, cancelOn }`
  follows the entity events (`meeting.created`, `meeting.deleted`) and the module's own: a
  command's event implements `NamedEvent` (`eventName`, `row`) to be one. `to` names the
  recipients (a user, a customer, a contact, or everyone with a role); `channels` is the order
  to try (`['push', 'whatsapp', 'email']`, or a delivery channel a feature registers);
  `whatsapp` (the template) is needed only when WhatsApp is one of them, `push`
  (`{ title, body, url? }`) only when push is; `onButton` answers its quick replies (snooze).
- The framework decides the rest per recipient: consent for the topic, quiet hours and the
  marketing cap (per business), the template in their language or English, and the next
  channel when WhatsApp can't be used or fails for good. No module code sends a message.

Live updates need nothing from a module: every committed event about a record reaches the
people who may read it (as ids), and the app refetches. A feature with records that are not
entities contributes a `liveResources` check for its type, or its events are never sent.

## What a module adds for voice and languages

Voice is a framework channel (the worker in `framework/voice-worker` calls `/api/chat` like the
app). The product speaks English, Hindi and Telugu (`@hykr/i18n`); a module brings its own
words, each as `Labels` (`{ en, hi, te }`, so a missing translation does not compile):

- **Views:** `labels: { title, empty, noun }`. A list view that can be spoken must have
  `noun` and `empty` (the registry refuses it otherwise); `speak(props, { lang })` returns the
  short spoken form, usually `spokenList(...)`. Components get `words` (title and empty line
  in the person's language) from the renderer.
- **Entities:** `fieldLabels`: what the approval preview calls each field, in the person's language.
- **Scripted model:** the module's verbs in each language (`verbs(...)`, before or after the
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
- Files (`/api/files`, `app.files`): uploads to object storage through presigned URLs, files kept
  on records' file fields and reached only through those records, a photo or document sent on
  WhatsApp kept for its sender (the assistant puts it on a record), transcription of audio, and
  `<FileField>` / `<FileThumbs>` in the app (developer guide, section 5.12). The sample's notes
  keep photos.
- Long-running jobs (`/api/jobs`, `app.jobs`): a module declares a kind of job with `defineJob`
  (contributed as `jobs`) and starts one in a command with `startJob`; the worker submits it, its
  service reports back by signed callback or is polled, and its result files are kept on the job
  and reached through the record it is about. `<JobProgress>` and `useJob` in the app (developer
  guide, section 5.14). The fixture's `drawings` shows one; the sample has none yet.
- Threads (one saved conversation per person, shared by every channel), voice sessions
  (`/api/voice/*`, LiveKit, the voice worker), and the framework's phrases in `@hykr/i18n`.
- Businesses, memberships and customers (`/api/me`), and the scope engine behind `access`.
- The durable event outbox (`app.domain_events`): every entity event, every `NamedEvent` a command
  returns and every approval request and decision, stored with the write that caused it. The worker
  relays each one to the event subscribers (developer guide, section 5.10). And the read path: each
  record leaves through `toRead(row, p)`, projected for whoever reads it.
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
- The models the assistant runs on: the deployment's OpenAI-compatible gateways (`MODEL_PROVIDERS`,
  OpenRouter in development) and each business's model policy (`GET /api/models`,
  `PUT /api/models/policy`), which picks every turn's model and fails closed (developer guide,
  section 7.5). The application only configures them in `.env`.
- The framework's tests (`framework/api/test/framework` and `framework/*/src/**/*.test.ts`).
  They use only those platform features and a fixture application of their own
  (`framework/api/test/fixture`), so they pass with no application at all. The golden WhatsApp
  conversations (`application/api/test/whatsapp`) run against whaloc-test and use the sample
  domain's words: replace them with the domain.
