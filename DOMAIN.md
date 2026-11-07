# The domain is replaceable

Basecamp, the agentic development stack for full-stack applications, ships with a sample
application: meetings, notes, to-dos and orders, as four modules, plus `account`, which words the
credits alerts. The framework (the API pipeline with
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
| Bundle | `index.ts` (server only) | `<name> = defineModule({ ...<name>Spec, server, views, screens, templates, notifications, agent, tables, contributes })` from `@hykr/api`; `contributes.featureFlags` lists the module's flags (`defineFeatureFlag`) |

Around the modules, the application keeps:

| Layer | Path | It must export |
|---|---|---|
| Modules list | `application/domain/src/modules/index.ts` | `modules`, in dependency order (a module after the modules it depends on), one line per module |
| Aggregates for the apps | `application/domain/src/contracts/index.ts`, `src/views/index.ts` | Every module's specs and views (`moduleSpecs`, `moduleViews`), one line per module. The apps import `@application/domain/contracts` and `/views`, or one module's `@application/domain/modules/<name>/contracts` and `/views` |
| Migrations | `application/domain/drizzle/`, `src/db/index.ts` | One journal for every module, generated from `src/modules/*/db/schema.ts`; `migrations` |
| Shared server code | `application/domain/src/server/` | What several modules use, such as `BUSINESS_ACCESS` |
| Server | `application/api/src/server.ts` | `server = defineServer({ name, persona, help, channel, modules, migrations })`: what the product is called, who the assistant is, and `channel.does`: what it helps with, in each language (WhatsApp's welcome and HELP). Optionally `contributes`: hooks and plugins by kind, among them queues, schedules, event subscribers, turn hooks, tools, delivery channels, connectors and connector handlers (developer guide, sections 5.9, 5.10 and 5.14), and the application's approval levels and level rules (section 5.8.1; the sample's are in `application/domain/src/server/approval-levels.ts`, passed through `@application/domain/server`) |
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
`customer`; a domain adds its own with `contributes: { roles, capabilities }`, relabels or
re-grants any declared role with `roleOverrides`, and names the roles a business's creator and a
WhatsApp contact get with `roleDefaults` (developer guide 6.4). Each business then defines its own
roles from those capabilities and edits the declared ones (its `roles` settings, `/api/members`).
An entity's `access` says what each role, or each capability, reaches, per read and write:

- `own`: rows the person owns; `customer`: rows of the customer they are; `tenant`: every row
  in the business; `{ grant: 'granted' }`: the rows granted to the person one by one
  (`/api/grants`), or, with `of` and `via`, the children of such a row.
- A key may be a capability (`'orders.read_all': 'tenant'`): that is how a role a business made
  reaches rows. A rule may be a list (`['own', { grant: 'granted' }]`).
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
capabilities for the apps. A field only some may see is declared on the spec,
`traits: { fieldPolicy: { cost: 'orders.cost.read' } }`: it is removed wherever the record leaves
for anyone without the capability, and filtering, sorting or writing it is refused. The sample's
to-dos module declares a `buyer` role and `todos.cost.read` this way.

Approvals take an object form, `{ when, by, channels, minAssurance, level }`: who decides (the
person it is for by default; a customer's request goes to holders of `approvals.decide`; `by`
names a capability, a person or an amount band, never a role), and where (`channels: ['app']` for
anything irreversible keeps it off WhatsApp buttons). Nobody decides their own request unless the
policy sends it back to them. What each approval level means (does it wait, who decides, how long
it can be undone) is the application's: the sample declares `read`, `internal`, `external` and
`irreversible` (`application/domain/src/server/approval-levels.ts`), and the to-dos module maps its
writes to `internal` with a level rule. Thresholds and approvers per amount band are each
business's settings (`approvals`).

## What a business sets up for itself

The framework's `settings` feature (developer guide, section 5.18) gives every business its own
setup, changed by people with `settings.manage` (owners and admins) through the write path:

- **Feature flags.** A module declares each flag and what it gates (modules, entities, commands,
  tools, app destinations) with `defineFeatureFlag`; a business has it on only when its settings
  say so. Off, its routes and writes answer 404, its tools leave the assistant and the app hides
  it. `managedBy: 'tenant'` lets the business switch it; otherwise only the platform does.
- **Custom fields.** An entity with the `customFields` trait and a `custom` column takes the
  fields a business defines (`/api/custom-fields`: text, number, yes/no, date, one of a list),
  checked on every write and filterable in lists. A required field binds the entity's own create
  and any write that sets custom values, not a command that makes the record without any.
- **White label.** Its name, logo and colours (`branding`), and its own web addresses, trusted once
  verified by a DNS TXT record. The settings plugin applies the colours; a screen shows the logo
  and name with `<BrandMark>` (the sample's Today does), since the shell still shows the product's
  title.
- **Shared records.** An entity defined with `defineSharedEntity` (trait `shared`) shows every
  business the rows of the platform's business (`PLATFORM_TENANT_ID`), read-only, and a business
  overrides one with its own copy. What is shared is the application's data.
- **Wording.** The application rewords framework phrases and notifications in `defineServer({
  wording })` instead of declaring them again; a business words phrases and notification emails
  in its `wording` settings.

The sample's to-dos take custom fields (a business adds its `priority`; the to-dos screen sets it
in its add form and each row's editor with `<CustomFieldInputs>`), and "clear done to-dos"
(`todo.clearDone`) sits behind the flag `todos.clear-done`, which the business switches itself.

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

## Places and totals

- **Places** (developer guide 5.15): a `geoPoint()` column (PostGIS) and an `addressColumn()`,
  the `geo` list type (`near`, `within`, nearest-first sort), and `withinMeters` for a geofence a
  command checks. The radius, and what a check-in means, are the module's: the sample's meetings
  take a check-in within their `CHECK_IN_RADIUS_M`.
- **Totals** (developer guide 5.16): every listed entity has `GET /api/<plural>/summary` (counts,
  sums, averages, lowest and highest, grouped by up to two fields) under its list's scope, and
  the assistant a `summarize-<plural>` tool. `kpi.row` tiles with `of` are computed from a
  summary for whoever looks; the sample's orders screen shows totals by status and by month.

## Documents (PDFs)

A module declares each document of its records with `defineDocument` (`@hykr/api`), contributed
as `documents` (developer guide, section 5.19). The template and every word in it are the
module's; the framework draws, stores and sends:

- **`load`** reads what the document shows, as the person who asks (the record and its
  children arrive projected for them, so a field they do not see is not in it). It is stored
  with each version.
- **`render`** lays it out (headings, fields, a table of lines, totals, a header and footer) in
  the language asked for, with `ctx.money`, `ctx.date` and `ctx.label`.
- **`send`** says how it goes out: a WhatsApp template with `header: { type: 'document' }` (also
  in the module's `templates`) and/or email wording.
- **`capabilities`** names what changes what it shows; `[]` when it shows nothing restricted.

A document's sends are listed in full only to people with `customers.message`; anyone else sees
their own. A read projector for resource type `document` or `documentSend` can hide more.

The sample's `orders` module ships `orders.order`, its template `order_document_v1`, and
scripts that make and send it.

## What a module adds for WhatsApp: templates and notifications

Outside a customer's 24-hour window WhatsApp delivers only approved templates, so everything a
module sends on its own initiative is a template, declared in code:

- **`defineTemplate`:** a versioned name (`meeting_reminder_v1`), a category, named parameters
  with an example each, the body in every language, at most three quick replies, and a
  document header for a template that carries a PDF. An approved template is never edited:
  changing the words fails `templates:sync` with "bump the version".
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
- Agent tools (`list-*`, `summarize-*`, `get-*`, `create-*`, `update-*`, `delete-*`, one per
  command), with approvals where the spec asks for them.
- `GET /api/<plural>/summary`: counts and totals under the list's scope and filters.
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
  guide, section 5.17). The fixture's `drawings` shows one; the sample has none yet.
- Documents (`/api/documents`, `app.documents`): a module's PDFs made in the worker from data
  read as the person who asked (pdfkit, HarfBuzz and the Noto fonts for English, Hindi and
  Telugu), stored as files the document holds, reached through their record, and sent by
  WhatsApp or email (`document.render`, `document.send`, the tools `render-document`,
  `send-document`, `get-document`, `list-documents`, and `<RecordDocuments>` in the app).
- Threads (one saved conversation per person, shared by every channel), voice sessions
  (`/api/voice/*`, LiveKit, the voice worker), and the framework's phrases in `@hykr/i18n`.
- Businesses, memberships and customers (`/api/me`), and the scope engine behind `access`.
- The durable event outbox (`app.domain_events`): every entity event, every `NamedEvent` a command
  returns and every approval request and decision, stored with the write that caused it. The worker
  relays each one to the event subscribers (developer guide, section 5.10). And the read path: each
  record leaves through `toRead(row, p)`, projected for whoever reads it.
- The integration bus (`framework/api/src/features/integrations`, `framework/connectors`):
  webhook endpoints that get the business's entity events signed, projected for each endpoint
  and retried, with a delivery log; connections to other systems with sealed credentials
  (`SECRETS_KEY`); inbound `/webhooks/<connector>/<connection>`, verified and stored once, whose
  events the application's `connectorHandlers` handle as the business's system principal. An
  entity keeps its events inside with `traits: { webhooks: false }` (developer guide, 5.14).
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
- Credits and caps: every business's assistant tokens and tool calls, WhatsApp messages and
  voice seconds metered and priced, a per-period allowance and a prepaid wallet, an alert and a
  pause as caps fill, an operator's override, and buying credits through a purchase provider
  (`/api/credits`, developer guide section 7.6). The application configures the prices and plans
  (`CREDITS_CONFIG` in `.env`), words the alerts (a notification on `credits.threshold`; the
  sample's `account` module) and lists `creditsPlugin` for the app's credits screen.
- Each business's setup: feature flags, custom field definitions (`app.custom_fields`), branding
  and verified web addresses (`app.tenant_domains`), shared records and wording (`/api/settings`,
  `/api/features`, `/api/custom-fields`, the back office's Settings screen, `settingsPlugin` in the
  app).
- The framework's tests (`framework/api/test/framework` and `framework/*/src/**/*.test.ts`).
  They use only those platform features and a fixture application of their own
  (`framework/api/test/fixture`), so they pass with no application at all. The golden WhatsApp
  conversations (`application/api/test/whatsapp`) run against whaloc-test and use the sample
  domain's words: replace them with the domain.
