# Decisions and assumptions register

The platform-gaps run built, on `feat/platform-gaps`, the 31 framework capabilities the gap analysis
found missing (A1 to A11, B1 to B20), the foundation they stand on (F0 to F6), and the fixes the
completeness, boundary and security reviews asked for. Each unit wrote its decisions down in
`docs/decisions/<unit>.md` before it wrote code. This page is the way in for the product owner:

1. [Index](#index): every decisions doc, the gaps it covers and what it built.
2. [Assumptions register](#assumptions-register): one table of every assumption, with what was
   chosen, where the choice came from, and the question to answer.
3. [Run report](#run-report): what merged, how it was checked, and the known gaps still open.

Everything that changes with the business (roles, approval levels and thresholds, currencies,
number formats, tax rules, states and SLAs, retention periods, prices, templates, languages) is
declared by the application or stored per business, never in `framework/`. So many answers below
change the sample application or a business's settings, not the framework.

## Index

| Unit | Gaps | What it built | Merged as |
|---|---|---|---|
| [F0](F0.md) | Foundation | Interfaces only: module, contribution, trait, hook and registry types, and one composition point, `defineServer({ contributes })`. | `f9dfc89a` |
| [F1](F1.md) | Foundation | Application modules on the server (`defineModule`, `defineServer({ modules })`), one validation pass at boot, the sample split into modules, per-module evals, `basecamp module add` and `db rebase`. | `39a37237` |
| [F2](F2.md) | Foundation | App modules (`defineAppModule`), `<AppShell modules plugins>` with plugin slots, duplicate binds refused, the mobile app split into modules. | `3f774835` |
| [F3](F3.md) | Foundation | The write and read path runs the seams: entity plugins, `toRead(row, p)` everywhere a record leaves, write hooks, the durable event outbox. | `36af8586` |
| [F4](F4.md) | Foundation | Actor kinds `system` and `guest`, assurance levels, more channels, the role and capability registry (`can(p, cap)`), `systemPrincipal()`, agent identity providers, tenant config in core. | `cb4f60db` |
| [F5](F5.md) | Foundation | Runtime registries: queues and schedules, features, the event relay and `defineSubscriber`, turn hooks, contributed tools, delivery channels, inbound hooks, erasure and export contributors. | `6e3405f0` |
| [F6](F6.md) | Foundation | Infrastructure for parallel work (worktrees with their own database and ports, split barrels, `sql/pre` and `sql/post` hooks, the migration skip guard) and the dependency preflight. | `1ca50c9d` |
| [A1](A1.md) | A1 | An MCP server over HTTP with OAuth 2.1, per-module tools under scopes, parked writes answered with an approval link. | `57d22607` |
| [A2](A2.md) | A2 | WebMCP: each screen declares read tools for a browser agent; the server refuses writes on that channel. | `fb0c102e` |
| [A3](A3.md) | A3 | Metering (tokens, tool calls, messages, voice), caps that alert at 80% and pause at 100%, a prepaid credit wallet with a ledger. | `3eae92dc`, `10411d7f` |
| [A4](A4.md) | A4 | Roles and capabilities a business shapes, per-record grants, invitations, fields hidden by capability on every read path. | `a1d76e88` |
| [A5](A5.md) | A5 | Approval levels declared by the application (undo window, deciders, channels, assurance, expiry), payload rules, named approvers per band, no self-approval, undo. | `3255795f`, `4decd0fd` |
| [A6](A6.md) | A6 | Agents a business makes: instructions, scope, owner, budget, seven kinds of trigger, a run queue, run tokens and a run log. | `8b8e9e3c` |
| [A7](A7.md) | A7 | An assistant run that parks is suspended and resumes in its thread when the request is decided. | `4cd620c0` |
| [A8](A8.md) | A8 | Business and record memory and conversation recall by meaning, re-checked for access, embedded through the model gateway. | `e75c7c72` |
| [A9B15](A9B15.md) | A9, B15 | Push notifications through Expo, falling back to the next channel (A9); live updates over SSE, filtered per connection (B15). | `de1f6184` |
| [A10](A10.md) | A10 | A deployment registry of OpenAI-compatible model gateways and a per-business model policy that fails closed. | `08e1fbce` |
| [A11](A11.md) | A11 | Feature flags, custom fields, white label and verified domains, platform-shared records, a business's own wording. | `fd6e0109` |
| [A11X](A11X.md) | A11 (export) | Exporting a business's data as the person who asks: a job that writes a zip of JSON and CSV per entity as a file. | `a8dd0445` |
| [B1](B1.md) | B1 | Files on records: presign, upload, confirm, reached only through the owning record; WhatsApp media kept; erasure. | `ccd38800` |
| [B2](B2.md) | B2 | Documents (PDF) declared by the application, rendered in the worker, stored, emailed and sent on WhatsApp. | `f1356696` |
| [B3B5](B3B5.md) | B3, B5 | Money in minor units with an ISO currency, number series, a tax-line primitive (B3); line items written whole under their parent (B5); the sample `orders` module. | `2e0969c3` |
| [B6B4](B6B4.md) | B6, B4 | Declared state machines with transitions, levels and SLA clocks (B6); versioned records, frozen in some states, revised as copies (B4). | `41f68b3a` |
| [B7](B7.md) | B7 | Parties and participations with participant roles the application declares, one person in several businesses, the business switcher. | `dbd3685c` |
| [B8](B8.md) | B8 | Accepting a document with a one-time code bound to its hash and version; append-only evidence; an `ESignProvider` interface with no provider. | `01faa882` |
| [B9](B9.md) | B9 | Share links (expiring, revocable, optionally OTP-gated) to a record, a page or a form; the guest principal; public routes in the app. | `485e00b1` |
| [B10](B10.md) | B10 | `@hykr/connectors`, signed outbound webhooks, verified inbound webhooks, encrypted per-business credentials, the egress guard. | `b5c4ced9` |
| [B11](B11.md) | B11 | Long-running external jobs: `defineJob`, signed callbacks, polling, progress, result files. | `80284f84` |
| [B12](B12.md) | B12 | Offline capture: a persisted outbox with the idempotency key fixed when queued, a persisted cache, `If-Match` conflicts, writes that park on sync. | `3a102cc3` |
| [B13B14](B13B14.md) | B13, B14 | Points, `near` and `within` filters and geofence checks (B13); summaries under the list's scope and KPI tiles (B14). | `038e7471` |
| [B16](B16.md) | B16 | Comments and @-mentions on any readable record, internal comments, an in-app inbox. | `e287b0e0` |
| [B17](B17.md) | B17 | Per-person Google Calendar sync, ICS invites and feeds, free time, a call log and a `TelephonyProvider` interface. | `08dc0289` |
| [B18](B18.md) | B18 | Personal data: requests with a deadline, export, erasure over contributors, retention, audit redaction, the register. | `e00ab149` |
| [B19](B19.md) | B19 | The platform-operator tier: named operators, consented and time-boxed support access, provisioning, inbound routing, a usage report. | `3c230097` |
| [B20](B20.md) | B20 | `basecamp import`: CSV, JSON or NDJSON through the write path as a job, re-runs keyed by external id, dry runs, an error report. | `1c2d3e30` |
| [H1](H1.md) | A4, A5, A9 | Notification words read as each recipient may, approval requests on every channel, sends held by the undo window, the contact role named by the application. | `9952ca62` |
| [H2](H2.md) | Settings (A4, A5, A8, B1, B3, B6, B7, B9) | One writer for every settings section that opts in (`PATCH /api/settings/sections/:section`), and the base settings. | `510f8033` |
| [H3](H3.md) | A1, A3, A8, A11 | MCP tool hints and flag gating; embeddings and the guardrail metered; agent calls refused at 100%; purchases settled only in their own business. | `0bed14f6` |
| [H4](H4.md) | B18 (with B8, B10, B17, A1) | Personal data in the later features' tables (calendar, calls, integrations, acceptance, MCP grants) under B18's export and erasure. | `c07ae275` |
| [H5](H5.md) | B8, B10 (sample) | The sample orders get an `accepted` state and the integration-bus demo (`order.placed`, the `orders-supplier` connector). | `c4d5310a` |
| [H6](H6.md) | Docs | The guides and developer guide section 14 brought up to date with B12 and H1 to H5. | `1d8ce163` |
| [S1](S1.md) | B19 | Support access holds only capabilities declared supportable, and what support makes ends with its grant. | `bfc9bfc8` |
| [S2](S2.md) | B10 | An inbound event is keyed by what its sender signed; `hmacConnector` can sign ids and timestamps. | `22d7b8f0` |
| [S3](S3.md) | B6 | SLA lists bounded, with reach in SQL and keyset pages; no clocks for readers who cannot open the record or see its state. | `d765cc8b` |
| [S4](S4.md) | A3, A8 | Embeddings under credits: the `embedding_tokens` meter, priced and capped, checked before recall and indexing. | `7d0dce73` |
| [X1](X1.md) | A3, A5 (boundary) | Who is outside the business is decided by standing and given roles, never by role name; credit alerts address the capability. | `e6e7e37b` |
| [X2](X2.md) | Boundary | Neutral tenant defaults: the time zone and the privacy contact are the business's, else the deployment's, else UTC or none. | `334d4a48` |
| [HLANG](HLANG.md) | Boundary | The application declares its languages (`defineLanguages`); English is the only fixed one and every word's fallback. | `befe10fc` |
| [HDOCS](HDOCS.md) | Docs | The guides read as one set against the merged code; a new `docs/modules.md` on working on modules in parallel. | `090fd9f3` |
| [HCONS](HCONS.md) | CI, evals | The consumer job as one script with evals in CI, spoken cases per module, `better-auth` pinned, the full CI run. | `10b54eae` |
| [REPORT](REPORT.md) | Report | This register and the run report. | this change |

Units are grouped as the run went: the foundation, the gaps (combined units such as `B3B5` built
two gaps together, and `A11X` is A11's data export), then the fix units from the reviews: H for
completeness, S for security, X for the framework/application boundary, and `HLANG`, `HDOCS` and
`HCONS` for languages, documentation and the consumer job.

## Assumptions register

How to read it:

- **Unit** is the decisions doc to open for the detail. A row naming several units is one
  question several units raised, merged; it states the latest answer.
- **Gap** is the gap the assumption belongs to (`Foundation` for F0 to F6; `Boundary` for the
  framework/application rule; `Settings`, `Docs`, `CI` and `Evals` for cross-cutting units).
- **Source** is where the choice came from: the PRD (tab and section), the gap list (the gap
  statement, or the gap map's risks and owner questions), the plan (including its boundary rule
  and hot-file table), a review finding, or a default: a conservative choice by the unit, failing
  closed wherever access is concerned, and reversible.
- **Question for the owner** is what to answer. "Confirm." means the unit asked for a yes or no on
  the choice itself. "Settled by H1" (or another unit) means a later unit answered it; the row stays so the
  change is visible. "None" means the unit reported the choice without a question.

The table has 484 rows: the 458 items of the units' "Assumptions to review" sections and
70 assumptions the units reported to the run that their docs do not state, less duplicates merged
and process notes left out (merging the integration branch into a unit, which test approach a fix
took, where a demo lived before its module existed). Those stay in each unit's doc.

| Unit | Gap | Topic | What we chose | Source | Question for the owner |
|---|---|---|---|---|---|
| F0, A5, B3B5 | A5 | Amount units | `AuthorizeResult.amount` is a `Money` (integer minor units and an ISO currency, A5 and B3); a threshold in another currency counts as exceeded, so the write parks. | Default | Settled by A5. Should an approval band ever compare amounts in different currencies? |
| F0 | Foundation | Contribution install time | Contributions install in `setRuntime` (API, worker, templates CLI, eval, Studio, tests). `migrate` does not install them. | Default | Does any migration-time code need hooks? |
| F0 | Foundation | Global registries | One application per process is assumed, as `setRuntime` already enforces. | Default | Is a multi-app process (one API serving two products) ever wanted? |
| F0 | Foundation | Read projection for external audiences | `ReadProjector.project` receives a `Principal`. Webhooks and PDFs for outside parties will pass F4's system principal, or a guest principal (B9). | Default | Should outside audiences instead get a separate, stricter audience flag? |
| F0, F3, A5 | A5 | An approved replay and the undo window | An approval ends the undo window: an approved replay opens none and holds no events. (F3 had kept the tier and the window on replay; A5 changed it.) | F3 open question; A5 default | Should an approved write still be undoable for a while? |
| F1 | Foundation | Composition time | Modules are composed when the server is defined, not switched per studio at runtime. A11's flags can gate a module by its stamped id. | Default | Is that enough, or must a module's routes disappear entirely for a studio that does not have it? |
| F1 | Foundation | One assistant | One persona for the whole product, with every module's tools on every turn. | Default | Should the assistant see only the tools of the module the person is in (and A1's MCP scopes)? |
| F1, HCONS | Evals | Evals in CI | Each module's evals run on their own (`basecamp eval --module <m>`, about 6 s a turn). The scripted-model evals now run in CI's `consumer` job against the scaffolded app, about four more minutes per pull request (HCONS). | Default | Is that acceptable per pull request, or should the evals run nightly, or per module as a blocking job of their own? |
| F1 | Foundation | Name collisions instead of prefixes | Entity names, tool ids and routes have no module prefix, and a collision fails at boot. | Default | Is that acceptable for Interioring (two modules both wanting a `line`), or should specs carry a prefix such as `quote.line`? |
| F1 | Foundation | Table naming | A module's tables must be named after it (`orders`, `orders_lines`). | Default | Should shared lookup tables (a catalog of brands) be allowed outside that rule? |
| F1 | Foundation | Downward foreign keys | `tableRef` lets a lower module's table reference a higher one by name (`notes.meeting_id → meetings`). | Default | Should such links instead move to the higher module (a link table), so a lower module never knows a higher one exists? |
| F1 | Foundation | Module name rules differ between halves | F1 allows `^[a-z][a-z0-9_]*$` (the name prefixes SQL tables and becomes a JS identifier); F2's app side allows `^[a-z][a-z0-9-]*$`. A name of lower case letters and digits fits both. | Default | Which one should win when F2 merges? |
| F1 | Foundation | `db rebase` base | It defaults to `main`. | Default | Should it read the base from the branch's upstream? |
| F1, HCONS | Evals | A module with nothing to evaluate | `basecamp eval --module <m>` fails when the module has no cases: nothing evaluated is not a pass. The sample's `account` gives the assistant nothing, so all three suites fail for it. | Default | Should a module with no agent part and no tools be skipped as a pass, so a loop over every module can run unattended? |
| F2 | Foundation | One URL prefix per module | A module's destinations must sit under `/<name>`. | Default | Should one module own several top-level prefixes (a `win` module with `/leads` and `/quotes`), or should such a module be split? |
| F2 | Foundation | Home and dashboards | The application owns the home screen and any screen that combines modules. | Default | Who owns studio dashboards that mix modules (a Morning Brief): the application, or a dedicated module that depends on the others? |
| F2 | Foundation | Public routes | A `public` plugin route renders signed out, without the shell; signed in, it renders inside the shell. | Default | Should a signed-in member opening a share link see it bare, as a homeowner would? |
| F2 | Foundation | Nav filters hide only | A filter can hide or reorder destinations, never add one. | Default | Is that enough for feature flags and roles, or must a flag also add a destination? |
| F2 | Foundation | Plugin failures are quiet | An `onSignedIn` error is logged, not shown. | Default | Should a failing plugin (push registration, offline sync) tell the person? |
| F2 | Foundation | WebMCP key | WebMCP tools are declared per screen context name (`useScreenContext({ screen })`). | Default | Is the screen context name the right key, or should tools hang off route paths? |
| F2 | Foundation | Module order | Destinations follow `order`, then the modules' list. | Default | Is a number enough, or should the application list its modules' order in one place? |
| F2 | Foundation | Back office | It stays framework-only. | Default | Do modules need staff screens there? |
| F2 | Foundation | Cross-module rows | The meetings screen uses the notes and to-dos rows. | Default | Is that coupling acceptable, or should a module offer views only through the registry? |
| F3 | Foundation | Entity rules that park | A rule's `needsApproval` now parks a CRUD write (it was ignored). | Default | Is that what you want, or should parking stay with `spec.approval` and plugins only? |
| F3 | Foundation | Raw rows in the outbox | Stored events keep every column, hidden fields included, and are filtered when they leave. Erasure (B18) must cover this table. | Default | Should the outbox instead store only what the read schema exposes (losing `tenantId`, owner and customer for routing)? |
| F3 | Foundation | Undo window and tier | Any decision with `undoMs` delays its events, whatever its tier. | Default | Should only tier 1 delay? |
| F3 | Foundation | Command results by schema identity | A command output is projected per entity only where it reuses the entity's read schema object. `Meeting.extend({ … })` is a new schema and is not projected per entity (the command's own projector still runs). | Default | Is a `present` override enough? |
| F3 | Foundation | A command's resource type for events | The default is the event name up to the first dot. | Default | Should commands always name it? |
| F3 | Foundation | History | Only the titles the history endpoint returns are projected. The audit rows keep full `before` and `after`. | Default | Should the audit trail itself redact hidden fields (B18 redaction)? |
| F4 | Foundation | Built-in roles | The framework always registers `owner`, `admin`, `ops`, `staff` and `customer`, and an application cannot remove them. | Plan boundary table (generic built-ins only); PRD (six roles) | Should the PRD's six roles replace them as the framework default (A4), or live in the application? |
| F4, A4 | A4 | Capabilities a business may grant | A business may give its roles any capability not declared `grantable: false`. Only `queues.admin` is (Bull Board shows every business's jobs). | Default (fail closed); F4 assumption | Should `channels.manage` or other framework capabilities also be closed to businesses? |
| F4 | Foundation | History for owners | Owners do not get `history.all` (only admin and ops), because that is how it works today. | Default | Should an owner see the whole business's history? |
| F4 | Foundation | MCP and WebMCP assurance | Both count as `session`. | Default | Is an OAuth bearer token from MCP as trustworthy as a signed-in session for tier-3 decisions? |
| F4 | Foundation | System principal reach | A system job reaches every row of its business. | Default | Should system jobs instead declare which entities they may touch? |
| F4, A3, A4, A10, H2 | F4, A4 | Settings cached for 10 seconds | A business's settings are cached for 10 s per process. The process that writes a change drops its copy (`settings.changed`, H2); other processes keep theirs up to 10 s. Approvals and SLA clocks read settings inside the write's transaction. A member's roles are read on every request, but a capability taken from a business's role, quiet hours, flags, branding, the model policy and an operator's credit pause reach other processes within 10 s. | F4 tenant config cache; default | Is 10 s acceptable everywhere, or should a change reach every process at once (an operator's pause in particular)? |
| F4, A6 | A6 | Agent channel | The assistant can forward only `app`, `voice` and `whatsapp`. | Default | Settled by A6: agent runs use a run-token identity provider. |
| F5 | Foundation | One second, and only where jobs run | The worker polls the outbox every second, so a subscriber runs up to a second after commit plus its queue time. An API that runs without a worker (and without `WORKER_INLINE=1`) relays nothing until a worker starts. | Default | Is that fast enough for A6 triggers and B10 webhooks, or should a commit wake the poller (Postgres `LISTEN/NOTIFY`)? |
| F5 | Foundation | No order across writes | Events go out in `seq` order within a batch. A transaction that commits after a later one is relayed on a later tick, and the shared `events` queue runs 10 jobs at once. | Default | Do any later units (A6 automations, B10 webhooks) need events of one record in order? |
| F5 | Foundation | A burst with "delete my data" is dropped whole | A photo or a question sent with it is neither stored nor answered; only the erasure runs and is confirmed. | Default | Should the person be told that the rest of what they sent was not kept? |
| F5 | Foundation | Relayed, not delivered | The outbox feed sets `relayed_at` once every subscriber's job is added, not when the jobs succeed. A job that fails for good stays in BullMQ's failed set, not in the outbox. | Default | Is that the intended meaning of `relayed_at`? |
| F5 | Foundation | Shared `events` queue | Subscribers with `handle` share one queue (concurrency 10), so a slow handler delays others. | Default | Should every subscriber get its own queue instead (two Redis connections each)? |
| F5 | Foundation | Refused turns are not saved | A turn refused by a hook (credits at 100%) leaves no message in the thread and no audit row. | Default | Should a refusal be saved to the thread, or audited, so the person and the studio can see why the assistant was silent? |
| F5, A8 | A3, A8 | Back-office reply drafts | Drafts pass the turn hooks and count against the business's caps. They get no memory recall, so internal facts never reach a customer (A8). | Default | Is that the intended billing for drafts? Should drafts recall at least the customer's own conversation? |
| F5, A10 | A10 | Model by name | A hook picks a model by id string (`openrouter/...`, later the gateway's ids). The audit's `agentVersion` still names the default model until A10 makes it per request. | Default | Settled by A10: `agentVersion` is per request. |
| F5 | Foundation | Inbound hook failures are swallowed | A hook that throws (storage down) is logged and the turn goes on without it. | Default | Should a failing media hook instead tell the person their photo was not saved? |
| F5 | Foundation | Channel retries | A non-final channel failure is retried 3 times for that recipient, then the next channel is tried. | Default | Is 3 the right number for push and in-app channels? |
| F6 | Foundation | Tests see the whole environment | Turbo now passes every variable to test tasks. | Default | Is that acceptable, or should tests run with an allowlist even though they are not cached? |
| F6 | Foundation | Hooks run on every migrate | `sql/pre` and `sql/post` files are not recorded; they run each time and must be idempotent. | Default | Should they instead run once, recorded by checksum, like migrations? |
| F6 | Foundation | Production privileges | A hook that creates an extension (B13's PostGIS) needs a role that may create it. | Default | Is the production migration role allowed to, or must extensions be created by an operator beforehand? |
| F6 | Foundation | The skip guard | `db:migrate` now stops when an unapplied migration is older than an applied one. A developer database that applied a migration which was later regenerated with an older timestamp must be recreated. | Default | Is failing preferable to drizzle's silent skip for every environment, production included? |
| F6, B2, HLANG | B2 | Document fonts | Only the Noto Latin, Devanagari and Telugu fonts are bundled, regular and bold, as dependencies of `@hykr/api` (about 19 MB installed, about 2 MB used). A declared language in another script shows in documents as missing glyphs. | Default; PRD Overview (English, Hindi and Telugu) | Are other scripts (Tamil, Kannada, Bengali, right to left) needed? Should a language declaration name its fonts? Should the fonts move to an optional package? |
| F6 | Foundation | CI connections | CI keeps Postgres' default 100 connections. | Default | Enough for one suite at a time; is CI ever expected to run suites in parallel? |
| F6 | Foundation | Expo config plugins | Expo config plugins are left to each gap (decision 26). | Default (F6 decision 26) | Should one unit add them all at once instead, accepting the push entitlement early? |
| F6 | Foundation | Package placement | `@mastra/memory` and `@ai-sdk/openai-compatible` went to `@hykr/agents`; `@mastra/mcp`, the S3 SDK, the PDF engine, `expo-server-sdk` and `@better-auth/oauth-provider` to `@hykr/api`. A gap that needs one elsewhere moves it. | Default | Confirm. |
| A1, A4 | A1, A4 | Hot-file deviations | A1 spreads each auth plugin's `schema` into the drizzle adapter in `framework/api/src/infra/auth.ts` (two lines: Better Auth's adapter 1.7.7 reads only `config.schema`). A4 adds a grant-kind seam to `framework/core/src/entity/define-entity.ts` (the `grantKinds` registry ORed into the scoped WHERE), because a plugin's scope can only narrow. Both merged; the plan's hot-file table was not updated. | Review findings; plan hot-file table (auth.ts: F4 → B7 → B19; define-entity.ts: F3 → B19 → B12) | None for the owner. If the plan is reused, record A1 and A4 in the hot-file table. |
| A1 | A1 | The framework features' tools over MCP | An MCP client gets each module's entities, commands and state transitions. It does not get the framework features' assistant tools: attaching and reading files (`files`), making documents (`documents`), a business's jobs (`jobs`), memory recall (`memory`), comments and mentions (`comments`), nor the platform's commands (handoff, notify, saved pages). Their routes declare no scope, so a token is refused there. | Default (fail closed); A1 review finding 1 | Which of these should an outside client have, and under which scope (the record's module's, or a scope of their own such as `files:read`)? |
| A1 | A1 | Protocol revision | `@mastra/mcp` 2.x serves only MCP 2026-07-28; a client that speaks only an older revision is refused. | Default (the installed `@mastra/mcp` 2.x) | Should we also serve older clients (a `@mastra/mcp` 1.x server beside it)? Which clients must work at launch (Claude, ChatGPT, Cursor)? |
| A1 | A1 | Who may connect | Any signed-up person who is a member of a business, customers included, reaches what they reach in the app. | Default | Should customers (homeowners) be refused? |
| A1 | A1 | Open registration | Any client may register itself. | Default | Should registration need an initial access token, or should only listed clients (CIMD) be trusted? |
| A1 | A1 | Write includes read | `<module>:write` also reads that module. | Default | Should reading and writing be separate scopes? |
| A1 | A1 | Every park links | Every parked write answers with the app link, not only the highest level. | Default | Is a lower level (an external send) better waited on silently? |
| A1 | A1 | One business per connection | The token works in the business the resolver gives the person at consent (their default one, else where they last became a participant). | B7 resolver (default membership, else latest participation); A1 decision 6 | Should the consent screen let a person in several businesses choose (B7's switcher is in the app now)? |
| A1 | A1 | Throttle per client | An MCP client gets the API's limit (120 calls a minute per route) for each person and business it acts for, like the assistant. | A1 decision 21; review finding 3 | Should outside clients get a lower limit, or one per business across all its clients? |
| A1 | A1 | Lifetimes | One hour access, thirty days refresh. | Default | Should some modules have shorter lifetimes (Better Auth's `scopeExpirations`)? |
| A1 | A1 | Branding | The consent screen shows the application's name, not the business's branding (A11's white label). | Default | Should it show the business's branding? |
| A1 | A1 | Credits | MCP tool calls count as tool calls and stop when the business is paused. | Default (A3 caps; H3 refuses the next call) | Is that right? |
| A1 | A1 | A token that outlived a disconnect | A refresh racing a disconnect leaves unrevoked tokens that are dead because the consent is gone (decision 23). If the person later connects that same client again within thirty days, those tokens work again, under the new consent (its scopes, the same client, person and business). | Default (A1 decision 23) | Acceptable, or should connecting again revoke every older token of that client first? |
| A1 | A1 | Signing out | Signing out of the browser does not disconnect a client; the person disconnects it (`DELETE /api/mcp/connections/:clientId`) or it lapses when its refresh token does (thirty days). | Default | Should signing out everywhere also revoke every MCP token? |
| A1 | A1 | Transition fields | An MCP transition action refuses any field the move does not declare, instead of dropping it silently as the assistant's transition tool does. | Default (fail closed) | None |
| A2 | A2 | Which screens first | Every screen that declares `reads` gets tools. Declarations are per screen, so this is application configuration. | Developer guide 5.7 (a browser agent is an agent); gap map risk on duplicated naming | Which screens and entities should a browser agent see first (the gap map asks about the record editor and the project board)? |
| A2 | A2 | Read-only until P3 | The server refuses every write on the `webmcp` channel. | PRD 7.1 'P0 read / P3 actions'; default to enforce on the server | When declarative actions come, should a WebMCP write park at a fixed level (wait for the person's approval in the app), or follow the action's own level? |
| A2 | A2 | Public and participant screens | Tools exist only for signed-in members. | Default, fail closed; gap map owner question | Should a share link or participant page (B9) offer read tools too? |
| A2 | A2 | Untrusted content hint | Every result is marked as untrusted content. | WebMCP draft ToolAnnotations; conservative default | Is that right for records only members wrote, or should it depend on the entity (records that outside parties write)? |
| A2 | A2 | Exposure | `exposedTo` is not set: the tools are offered the browser's default way. | Default | Should tools be limited to particular agents or origins (`exposedTo`), or is the browser's default enough? |
| A2 | A2 | Open record | The `get-<name>` tool says which record is open. | Default | Should a screen also offer a "what is on this screen" tool (the filter in use, the visible rows)? |
| A2 | A2 | Refusals not audited | A write attempt on the `webmcp` channel is refused before the write path and leaves no audit row. | Default following the existing relay refusal | Should such attempts be recorded? |
| A2 | A2 | Where the tools run | An AppPlugin `webMcpPlugin()` that the application lists in `<AppShell plugins>`. A module cannot bring it, because plugin names are unique. | Plan A2 row and task notes (adapter + hook as an AppShell plugin); F2 decision 11 | Should the shell install WebMCP by default instead of the app listing it? |
| A2 | A2 | Which browser API | Feature-detect `document.modelContext` (WebMCP CG draft of 2 Nov 2026, Chrome docs), then `navigator.modelContext` (early preview, the gap's wording). Register with `{signal}`; also call `unregisterTool` if present. All of it lives in one adapter file. | PRD Platform & AI 7.1 'behind feature detection'; gap map risk (draft API, one adapter file); WebMCP draft | None |
| A3 | A3 | Unit of credit | A credit is a minor unit of money in one deployment-wide currency. | Boundary rule (money is integer minor units plus an ISO currency); gap map owner question; this keeps A10's model prices usable as they are. | Should credits be an abstract unit with a separate price per credit when buying? |
| A3 | A3 | One currency per deployment | A business cannot hold credits in another currency. | Default | Confirm. |
| A3, B19 | A3, B19 | Who operators are | Named, signed-in people in `app.platform_operators` with operator capabilities; the first is added with `basecamp operator add`. B19 removed A3's shared `OPERATOR_API_KEY`. | A3 decision 7 (B19 replaces the key); gap map | Should operators have roles (support desk, finance, admin) instead of capability lists? |
| A3 | A3 | What pauses at 100% | What pauses at 100%: assistant turns (all channels and drafts), new voice sessions, and the message variants the plan lists (none by default; the sample lists `marketing`). Replies, codes, approvals, handoffs and staff messages never pause. | Gap map risks (safety-critical sends, stranded customers) | Should anything else pause (A6 agent runs will check `CreditsService.check` too)? |
| A3, H3, S4 | A3 | Overshoot past the cap | The cap is checked before a turn, a voice session, a message, each agent call (H3) and each indexer batch of up to 50 texts (S4), never in the middle of one, so one of them can take a business past 100%. The wallet can go negative by that much. | Gap map risk (a turn can overshoot; counters must be atomic); A3 decision 14 | Is that bound acceptable? |
| A3 | A3 | WhatsApp pricing | Messages are metered when sent, per message, priced by template category; free-form replies inside the 24-hour window are the variant-less `messages` price (set it to 0 if Meta does not charge). | Default | Should Meta's conversation-based pricing be modelled instead? |
| A3 | A3 | Voice metering | Voice is metered per business per period on top of the existing per-person daily limit (`VOICE_DAILY_MINUTES`), which stays. | Gap map risk (per person versus per business) | Should the per-person limit go? |
| A3 | A3 | Paused customers | Customers are handed to staff when the assistant is paused. | Gap map risk (a clear refusal plus a handoff) | Is a handoff the right default for a paused business's customers? |
| A3 | A3 | Studio and eval turns | Studio and eval turns are not metered when they have no business. Evals with a business are metered like any turn. | Default | Confirm. |
| A3, X1 | A3 | Who hears a credit alert | The application's notification addresses `credits.manage`; dispatch finds its holders, with the business's own roles, when the alert is sent (X1). The sample sends it by WhatsApp, then email. | Boundary rule (wording is the application's); X1 fix | Should the platform operator be told too? Should an alert go to whoever held the capability when the cap was reached, rather than when it is sent? |
| A3 | A3 | Periods | Periods are calendar periods in the business's time zone. | Default; F4's tenant config cache | Should a period start on the business's billing day instead? |
| A3 | A3 | A failed send is free | Messages count once the provider accepts them. | Default | Confirm. |
| A3 | A3 | Credits never expire | Top-ups have no expiry and grants none either. | Default | Should granted credits expire at the end of a period? |
| A3 | A3 | Negative balance | A negative balance stays (an overshoot past the wallet) until a top-up or grant covers it; until then it shrinks every period's budget. | Default | Should a new period's allowance pay it off instead? |
| A3 | A3 | The sample's plan | The sample puts every business on credits with an included allowance of 500.00 a month. | Default (sample proof) | What should the real plans include, and should a new business start on credits at all? |
| A3 | A3 | Where the plan lives | Each business's plan is the `credits` tenant settings section, layered over CREDITS_CONFIG.defaults and neutral framework defaults (not enforced, allowance 0, month, alert 80, pause 100). Only the operator writes it; the business sets only its alertAt. | Gap A3 (prices, allowances and thresholds from configuration and tenant settings; caps off until configured). Default: fail closed, so a business cannot set its own allowance. | Settled by H2: a section with its own writer (credits) does not opt in to the generic settings writer. |
| A3 | A3 | Token pricing | In order: the price for `tokens.<model ref>`, then the `tokens` price, then the model's A10 price plus `markupPercent` when its currency matches the credits currency, else 0 (logged once per model). Studio turns (no business) are not metered. | Plan note (price table from A10); A10 decision 7 | Should an unpriced model refuse turns for a business on credits, instead of costing nothing? |
| A3 | A3 | Settings that do not parse | Fail closed: voice and paused message categories are refused (credits_unavailable) and GET /api/credits answers 503. Turns are refused by the model policy (503 model_policy_invalid). What is never paused still goes. Recording falls back to the deployment's defaults. | Default (fail closed); A10 decision 10 | None |
| A4 | A4 | Who manages roles | `members.manage` (owner and admin by default) manages every role, including giving roles capabilities the manager does not hold. | Default (decision 8) | Should a manager only grant what they hold themselves? |
| A4 | A4 | Writing hidden fields | A field's write capability defaults to its read capability; a spec can declare `{ read, write }` separately. The PRD's "procurement sets cost that designers never see" works by giving that role the capability. | Gap map owner question; fail closed (decisions 17, 21) | Is there a role that should write a field it cannot read? |
| A4 | A4 | Granted rows and owners | Under `granted` alone, a person cannot create a top-level record. | Default, fail closed (decision 14) | Should a designer be able to start a project and be granted it automatically? |
| A4 | A4 | Invites | One use, matching email, 7 days, and the joined business becomes the default. | Default (decisions 23, 24) | Is an invite by phone number (WhatsApp) needed before B7's participants? |
| A4, H1 | A4 | Notification words and hidden fields | Done in H1: the dispatcher projects the row for each recipient before a notification's words are built (`docs/decisions/H1.md`, decisions 1 to 4). | Default | Settled by H1 (decisions 1 to 4). |
| A4 | A4 | Child entities and own | Documented, not enforced: a child entity must not give a limited role `own`, otherwise that person can attach children to parents they cannot see. Use granted via the parent's column instead. | Found in testing (decision 27) | Should defineEntity warn when a child entity grants `own`? |
| A5 | A5 | Level 2 for a person's own send | The sample's `external` level parks only when an assistant or a background job sends; a person sending themselves goes ahead (they are the human the PRD asks for). | PRD Platform & AI 7.1 (tier 2 sends wait) + default | Should a person's own send to someone outside also wait, and for whom? |
| A5 | A5 | Who loosens | A business may switch off parking only for levels the application marks `tenantMayLoosen` (the sample: `external`). | PRD Platform & AI 7.3 ('few will loosen tier 2'); fail closed | Should owners be able to loosen any level? |
| A5 | A5 | No threshold set | `overThreshold` counts a missing threshold as exceeded, so a new business parks every amount until it sets one. | Default, fail closed | Should a missing threshold mean "never parks" instead? |
| A5 | A5 | Named approver who asked | When the band's named approver is the requester, the request goes to holders of `approvals.decide` other than them. | Default | Should it go to the next band up, or to the owner? |
| A5 | A5 | Self-approval everywhere | An owner alone in a business can no longer approve their own marketing send or a customer-facing request the policy sends to a capability. | Gap list ('self-approval forbidden') | Is a single-person business allowed to approve its own requests? |
| A5 | A5 | Overriding the framework capabilities | An application can give more roles `approvals.decide` but cannot take it from `owner` or `ops`; it names its own capability on its levels instead. | Task boundary audit (2); F4 registry semantics | Is that enough, or should a business be able to remove the default holders? |
| A5 | A5 | Undo window length | The sample's internal level gives 10 seconds. | Default | What should the product's window be, and should it differ per channel (WhatsApp replies are slower)? |
| A5 | A5 | Undo of a delete | Rows removed by cascade with the deleted row are not put back. | Default | Should an entity with children refuse undo instead? |
| A5 | A5 | Approval list for the requester | The requester can open their own request read-only (deep link). | Default (deep link must work for both) | Should they also see a list of everything they are waiting on? |
| A5, H1 | A5 | Sends in an undoable write | Done in H1: outbox sends and notifications (now scheduled from the stored events) wait for the undo window, and an undo withdraws them (`docs/decisions/H1.md`). | Default (scope) | Settled by H1. |
| A5 | A5 | The assistant cannot undo | A person undoes their assistant's write in the app; there is no tool for "undo that" on WhatsApp. | Default | Should there be an "undo that" tool for WhatsApp and voice? |
| A5 | A5 | Live updates wait for the undo window | A to-do the assistant adds shows on the person's other open screens 10 seconds later (#31). | Default | Is that delay acceptable, or should live signals go out at once with a second signal when a write is undone? |
| B3B5, A5 | A5, B3 | The sample orders' approval | An assistant's save of an order waits for the person. A total above the business's limit (`money.amounts['orders.approval']`) waits for an owner in the app: the orders module names `irreversible` on its own over-limit decision instead of contributing a level rule, so an order saved under the limit has no level and no undo window. | PRD Platform & AI §7.1 tiers, as sample configuration; plan boundary section | Should orders under the limit be `internal` and undoable? Should the limit move to `approvals.thresholds`? |
| A5 | A5 | Replay bounds | A replay fails if its level now ranks higher or its amount grew (another currency or an amount where none was approved counts as larger); this also fails requests parked without a level that gain one after a deploy | Gap map risk; fail closed | Should a replay instead re-park at the higher level? |
| A5 | A5 | Where the marketing decider lives | On the marketing_send decision (DecisionDetails.approver), not on the command's approval rule. The precedence order in decidersFor (decision approver, op.approval, level policy) is unchanged. | Fix round 1 finding, option 1 (the reviewer's preferred fix). Decisions doc #29. | Should the framework also stop an operation's approval.by from overriding a level's park, or is documenting 'a decider for one reason goes on that decision' enough? |
| A5 | A5 | The assistant's service send in the sample now waits | In the sample, a utility template the owner's assistant sends parks at `external` and the owner decides it. It no longer runs at once as it did before A5. A person's own send still runs. | PRD Platform & AI 7.1, tier 2 (sends to outside parties wait). Decisions doc #28. | Should a send the person asked their assistant for in the app run without the extra approval step? |
| A6 | A6 | Who makes agents | Owners and admins (`agents.create`). | PRD Platform & AI §5, §6 (owners and managers set up agents); default (fail closed) | Should staff make their own (they act only with their own rights anyway)? |
| A6 | A6 | Ownership never moves | When an owner leaves, their agents' runs are refused until someone deletes them. | PRD Platform & AI §6 ("acts for a named owner and can never exceed that person") | Should a manager be able to take an agent over (as its new owner, after reading its instructions)? |
| A6 | A6 | Managing others' agents | A manager may pause, run and delete anyone's agent, but not edit it. | Default | Is that right? |
| A6 | A6 | Scope is tools | An agent's scope is a list of the assistant's tools (at most 50), not modules or records. | Gap map owner question ("what does scope mean"); default | Should a scope also narrow to records (one project)? |
| A6 | A6 | Approval of an agent's writes | The owner decides what their agent's run asks for (like their assistant's). | CLAUDE.md approval rule (the person decides on their own assistant's request); A7 | Should a business be able to send agent runs' requests to a named approver? |
| A6 | A6 | Inbound messages | An agent sees a customer's WhatsApp message only if its owner holds `backoffice.use`, and it never answers the customer itself (the assistant does). | Gap map extension point (InboundHook); Meta policy risk; default (fail closed) | Should an agent be able to take over a conversation (Meta's policy allows the business's own tasks)? |
| A6 | A6 | Webhooks | Agents take events from their own connector (`agent-webhooks`); other connectors only when the application opts in. | Plan A6 row (webhooks through B10); B10 registry | Should every connection be open to agents? |
| A6 | A6 | Budgets | Runs, tokens and credits per day, week or month; a run may overshoot once. | Plan A6 row (budget through A3); PRD Platform & AI key result (auto-pause at 100%) | Is an 80% alert per agent needed (the business's alerts exist)? |
| A6 | A6 | Run log visibility and retention | The owner sees full runs; a manager who is not the owner sees an outline (trigger, status, reason, tool names and outcomes, usage), because replies carry records as the owner reads them. Deleting an agent deletes its triggers, run log and thread; the audit trail keeps its writes. | Gap map owner question (run-log retention, who sees it); default (fail closed) | Should managers see full runs? Should the log outlive the agent for a set period? |
| A6 | A6 | Conditions are polled | A condition is the entity's list filters, checked as the owner every 5 to 1440 minutes (default 15); each record that newly matches starts one run. | Default | Is a 5-minute floor right, and should conditions also be checked on the entity's events? |
| A6 | A6 | What a trigger hands the run | An event's or a mention's record comes as its owner reads it, even when the agent's scope has no tool for that entity (the owner asked for it by naming the event). | Default; F5 `eventFor` | Should the data be cut to what the scope reads? |
| A6 | A6 | Deleted records | An event about a record that is gone (`*.deleted`) starts nothing, since the owner can no longer read it. | Default | Should delete events start agents with the record as it was? |
| A6 | A6 | Loop guards | An agent's own runs' events never restart it; chains through other agents stop deeper than 3 levels; at most 10 runs per agent are queued or running at once. | Gap map risk (feedback loops); default | Are depth 3 and 10 open runs the right guards? |
| A6 | A6 | A note on Run now is the owner's only | A manager runs anyone's agent but cannot add a note (403). | Review finding 3; A6 decision 2 | Should a manager instead be able to send a note that the run gets without the owner's rights (for example only as text in the run log, never to the model)? |
| A6 | A6 | A fired `once` trigger | A `once` trigger that fired stays in the definition: it never fires again, and an edit keeps it as it is. | Default | Should the editor show it as done, or drop it from the definition once it fired? |
| A6 | A6 | Run limits are not MCP scopes | A run token reaches every route its owner reaches except what the run's own checks close (entity reads and every write outside the scope, the agents' routes). | Review finding 2 (both options it offered); default (fail closed) | Should a run also be limited to routes that declare a scope, as MCP tokens are (which would close contributed tools such as comments and memory until their routes declare one)? |
| A6 | A6 | Run identity | Each run's token is an HMAC of its run id with `AGENT_API_KEY`, never stored, accepted only while the run is running or waiting and its agent is active. Requests use the background channel, in the run's business. | Plan A6 row (run-token identity); F4 `AgentIdentityProvider` | Should run tokens use a separate secret instead of `AGENT_API_KEY`? |
| A6 | A6 | Agent threads | One thread per agent (`threads.kind` 'agent'), owned by its owner. Each run adds its prompt and reply but reads no history, so runs never land in the person's own conversation. | Task note; gap map extension point | None |
| A6 | A6 | Ready-made agents | Templates are application content (`defineAgentTemplate`, contributed as `agentTemplates`); the framework ships none. The sample's meetings module offers a weekly to-do agent and a follow-up agent. | Plan boundary section | None |
| A6 | A6 | One-line drafting | In chat, the assistant's `create-agent` parks for the person and the approval card shows the draft; the scripted model drafts from `create an agent to <job> [every <day> at <time>] [using <tools>]`. | PRD Platform & AI §6 (describe a job in one line) | Should the app's editor have its own "describe it" box that asks the assistant for a draft? |
| A6 | A6 | Run log as bookkeeping | Run rows, trigger state and condition hits are written directly by the feature, like deliveries and inbox items. Agent definitions and every write a run makes go through `runWrite`. | CLAUDE.md rule 1 (domain writes); B10 and B16 precedent | None |
| A7 | A7 | Who hears the continuation | It goes to the person the run acted for, in their thread (and on WhatsApp when the run was on WhatsApp). The approver, when someone else, is not told what the assistant did next. | Default | Should the approver be told too? |
| A7 | A7 | Turns in between | If the person keeps chatting while a request waits, the resumed run does not see those later messages (it continues from where it stopped), and its reply lands after them in the thread. | Default | Is that acceptable, or should a newer turn cancel the parked run's plan? |
| A7 | A7 | Rejected means stop | The model is told to stop the rest of the plan when a step is rejected or expired. | Default | Should it ask what to do instead? |
| A7 | A7 | WhatsApp outside 24 hours | A decision that arrives after the window closed sends nothing on WhatsApp (the app shows it). | Default | Should there be an approved template for "your request was decided, open the app"? |
| A7 | A7 | Approve twice on WhatsApp | A person who decides with the button hears the button's answer ("Done: …") and then the assistant's continuation. | Default | Is the double reply wanted? |
| A7 | A7 | Refused resumes | When the business is out of credits at the moment of the decision, the run stays suspended and the thread says it could not continue; nothing resumes it later. | Default | Should a top-up resume paused runs? |
| A7 | A7 | New code, old run | A run parked before a deploy continues under the new instructions and tools. | Default | Is that right for long waits (the irreversible level waits up to 72 hours)? |
| A8 | A8 | Who reads business memory | Every member with `memory.read` (owner, admin, ops and staff by default) reads all of the business's memory; customers never. | CLAUDE.md capability rule; default | Should some memory be visible to managers only (a per-memory audience), or should staff not see it at all? |
| A8 | A8 | Who writes it | Anyone with `memory.write` adds memory and edits or deletes their own; `memory.manage` (owner, admin) edits anyone's. | CLAUDE.md capability rule; default | Should business memory instead need an owner's approval before it is recalled for everyone? |
| A8 | A8 | The assistant writes memory without approval | "Remember that we close on Sundays" is saved at once (changes and deletes wait for approval). | PRD tier 1; default | Should the assistant's memory writes wait for approval, given that recalled memory reaches every member's turns? |
| A8 | A8 | No automatic memory | Memory is written by people or by the assistant when asked. Nothing is extracted from conversations automatically. | Default | Is automatic extraction (with review) wanted? |
| A8 | A8 | Record memory is the application's entity | A product that wants project memory declares an entity (or reuses one) with the `memory` trait and `about: project`. | Boundary rule; plan hot-file table; gap map risk on leaks after role changes | Is that the intended shape, or should the framework ship a generic "memory about any record" entity once entities can share their scope (an `EntityDef` change)? |
| A8 | A8 | Conversation recall | Only the person's own words are recalled from conversations, never the assistant's replies. | Plan note (resource key tenant+subject); fail closed | Is recalling replies (with the risk that they quote what the person may no longer see) wanted? |
| A8 | A8 | Recall on by default | Recall is on by default for every business whose policy allows an embedding model. A business turns it off in its `memory` settings or by leaving the embedding model out of its policy. | Default; A10 decisions 16 and 22 | Should it be off until a business turns it on (it costs an embedding per turn)? |
| A8 | A8 | Recall defaults | Defaults: five memories per turn, similarity at least 0.3, 400 characters each. | Default; A10 decisions 16 and 22 | Are these right for the production embedding model? |
| A8 | A8 | Erasure of memories | Erasure deletes the memories a person wrote (when the person has an account). | F5 contributors; DPDP default (fail closed) | Should they be kept for the business and only their author removed? |
| A8 | A8 | Index lag | A new record is recallable about a second after it is written (the index job runs every second in the worker). | Default | Is that acceptable? |
| A8 | A8 | Provider timeout and lease | One batch's embedding call is abandoned after 30 s (and retried with backoff, five tries), and a claim whose run died is taken over after 120 s. | Default | Are these right for the production provider, or should they be deployment settings? |
| A8 | A8 | Recall's bound | A turn waits at most 4 s for the embedding of its message (1.5 s on voice), in one try, then runs without recall; the recall API answers 503. | Default | Is that the right trade between latency and recall for the production provider (a typical embedding takes well under a second), or should it be a deployment setting? |
| A8 | A8 | Mastra Memory | @mastra/memory and SemanticRecall are not used. Recall is the API's own so that access is re-checked. The package stays installed but unused. | Gap map extension points; rule 2 (assistant is a user) | None |
| A8 | A8 | Recall scope | Recall (the turn hook and the API alike) only covers entities whose `get` is exposed to the assistant ('all'). People-only entities are never recalled. | Default, fail closed (recall feeds the model) | None |
| A9B15 | A9 | Who gets push | Any person with an account who installs the app and allows notifications, staff or customer. | Default | Should customers (participants) get push at all, or WhatsApp only? |
| A9B15 | A9 | Expo's push service | Messages pass through Expo, then Apple or Google, outside India. | F6 decision 25 (expo-server-sdk); gap map risk | Is that acceptable for production, or must the product send through FCM and APNs directly (a second sender behind the same channel)? |
| A9B15 | A9 | When push has failed | No device, a refusal, or an error receipt moves on to the next channel. An unread push does not. | Gap map risk and owner question; default | Should "not opened within N minutes" also fall back to WhatsApp? |
| A9B15 | A9 | Receipt timing | Receipts are checked a minute after a send, every minute. A failure is found 1 to 2 minutes later, so the next channel is that much later. | Expo-server-sdk README; default | Is that acceptable for reminders? |
| A9B15 | A9 | Quiet hours and service pushes | Service-topic notifications ignore quiet hours on every channel, push included. | Default | Should push respect quiet hours even for service topics? |
| A9B15, H1 | A9 | Push text on a lock screen | Push words are built from the record as the recipient may read it (field policy, since H1). An approval request's push shows the request's summary. | Default | Should some notifications, approval requests among them, show only a neutral title ("Something waits for you")? |
| A9B15 | A9 | Per-business devices | A person in two businesses registers the device once per business (the app registers again after a switch). | Default, fail closed | Is per-business the right scope? |
| A9B15 | B15 | Live coverage of deletions | A deletion reaches only streams already told about the record, and the person who deleted it; others see it go at their next refetch (focus, reconnect, their own write). Visibility uses the entity's scoped read, because `EntityDef` exposes no pure `canRead(p, row)`. | Default (fail closed); plan hot-file table | Must every reader see deletions at once (which needs `canRead` on the entity)? |
| A9B15 | B15 | Live latency | Events go out after the worker's outbox poll (up to a second) and a queue job. | Default | Is about 1 to 2 seconds acceptable? |
| A9B15 | B15 | Stream limits | 8 streams per person per process, 15 minutes per stream. | Default | Are these the right numbers? |
| A9B15 | B15 | Back office | It still polls its inbox every 10 s and an open conversation every 5 s. | Task note 'where easy'; hot-file table | Should inbound messages and handoffs publish live events too? |
| A9B15, H1, H6 | A9, A5 | Order of channels | Each notification's `channels` list is its fallback order; the framework has none of its own. The sample's to-do reminder and the framework's approval request go by push, then WhatsApp, then email (H1); an application changes the approval request with `overrideNotification`. | PRD Platform & AI §7.1 (channels); plan boundary section | Does every notification follow push, WhatsApp, email, or does each choose? Should a business be able to change the order per approval level? |
| A9B15 | A9 | A9 forget without a session | POST /api/push/tokens/forget needs no session: holding the token is the proof, it can only stop pushes, and it always answers 204. | Default (the shell signs out before plugins' cleanups run, F2 decision 13) | Acceptable, or should the app keep a per-device secret? |
| A10 | A10 | No policy means the defaults only | A business that never set a policy may use the deployment's default chat and embedding models, nothing else. | Default, fail closed (gap A10 "fails closed"; gap map risk on silent fallback) | Should a business without a policy instead get every model the deployment offers? |
| A10 | A10 | The business sets its own policy | Owners and admins (`models.manage`) choose among the deployment's models. | Gap map ownerQuestions (operator vs studio); default | Should residency be set only by the platform operator (B19), or be a plan option the business cannot change? |
| A10 | A10 | A model the business does not allow | A turn whose hook asks for a model the business does not allow is refused (403 `model_not_allowed`), not given the business's default model. | Default, fail closed | Is a refusal right, or should the policy quietly use the business's own model instead? |
| A10 | A10 | No fallback, ever | A provider outage fails the turn. | Gap map ownerQuestions (allowed fallback outside India, with whose consent) | Is a fallback to another provider (in the same region, or anywhere with the business's consent) wanted? |
| A10 | A10 | Residency | Residency is per business (`regions`) and per deployment (which providers it configures). | Gap map extension point (modelPolicy allowed models, region); default | Should a production deployment refuse to start with a provider outside a required region? |
| A10 | A10 | Speech | Speech is not under the policy. | Gap map ownerQuestions (do STT/TTS fall under the same policy) | Should STT and TTS providers be chosen per business too? |
| A10 | A10 | Prices | Prices are the deployment's cost in minor units per million tokens, rounded up per call. | Gap map risk (price table needed for A3); boundary rule (minor units + ISO currency) | Is per-call rounding acceptable for credits (A3), or should cost be summed exactly and rounded once? |
| A10 | A10 | Who sees prices | Only `models.manage` sees prices. | Default | Should every member see what a model costs? |
| A10 | A10 | An unnamed embedding model is not checked on save | A policy whose `allowed` leaves out the default embedding model saves, and memory recall is then refused for that business. | Default (a policy that refuses every turn is a mistake; no memory recall may be deliberate) | Should saving warn or refuse instead? |
| A10 | A10 | Which in-country provider, and its region name | The sample's `.env.example` uses a placeholder gateway URL and region `in`. | PRD platform-ai 7.2 ("model gateway, in-India provider for production"); gap A10 | Which provider and which region names does production use? |
| A10 | A10 | The scripted model stands in for every model in fake mode | Tests and demos never reach a gateway unless a test points `MODEL_PROVIDERS` at a stub and switches to live mode. | Default | Confirm. |
| A10 | A10 | Deployment default must exist | In live mode every turn is refused with 503 model_not_configured unless the deployment's default chat model (AGENT_MODEL, else the first listed) is configured, even for a business with its own chat model. | Default; matches the old OPENROUTER key check | Should a business with its own model run even when the deployment default is misconfigured? |
| A11 | A11 | Who switches flags | Flags default to platform-managed. | PRD Overview: pilot roll-out and fail-closed flags; gap map owner question | Which flags may a business owner switch on by themselves, and are some flags plans (billing, B19)? |
| A11 | A11 | Switched-off records elsewhere | A flag that is off hides routes, writes, tools and nav. Records already in history, approvals or stored events still show. | Default (reversible: a flag is a product switch, not an access rule) | Should switching a module off also hide its records in history and approvals? |
| A11 | A11 | Required fields and records made by commands | A required field does not stop a command that makes the record without custom values (closing a meeting makes its to-dos with the field unset). | Default | Should such records be flagged for someone to fill in (a list filter "missing priority", a reminder), or should a business be able to give a required field a default? |
| A11 | A11 | Custom field types | Text, number, yes/no, date and one-of-a-list. | Gap list A11 'typed, filterable'; default fail-closed until A4 | Are multi-select, money (minor units) or a link to another record needed, and should custom fields be sortable and searchable? |
| A11 | A11 | Who defines fields | Owners and admins (`settings.manage`). | Default | Should a business's own roles (A4) be able to read or manage definitions? |
| A11 | A11 | Custom domains | Verification is a DNS TXT record. | Security default: no domain squatting, and no trust without proof | Does the product also need the domain's own sign-in cookies (one session per domain), and who issues TLS certificates? |
| A11 | A11 | Logo | The logo is an https URL (`branding.logoUrl`); there is no upload. | Gap list A11 ('logo via B1 if present') | Should the logo be an uploaded file (B1) and per-language? |
| A11 | A11 | Where the brand shows | Today a business's logo and name show on the sample's Today screen and in the back office; the app's rail, phone bar and sign-in still show the product's name (`AppShell` is B9's, then B12's). | Review finding 1 fix instructions; plan hot-file table (AppShell.tsx F2 → B9 → B12) | Should the business's name replace the product's everywhere, or sit beside it ("Acme, on Basecamp")? And on a business's own domain, should the app's sign-in show only the business's brand? |
| A11 | A11 | Shared records | One platform business holds every shared row, curated by its members. | Plan boundary table 'platform-scoped shared records'; default fail closed | Can other businesses publish to the shared set (a supplier's library), and should an override follow later changes to the shared row (today it is a full copy)? |
| A11 | A11 | A business's email wording and hidden fields | A business's email subject and body fill `{field}` from the whole record, so a settings manager can put any field of it in an email, one hidden from the recipient by a capability included. | Default | Should a business's wording be limited to the fields the recipient may read (A4 field policy)? |
| A11 | A11 | Wording per business on WhatsApp | A business's phrases reach the app and anything that calls `tenantPhrase`. The WhatsApp replies in `inbound.processor.ts` (a hot file) still use the application's phrases until that file's owner switches to `tenantPhrase`. | Plan hot-file table; Meta template approval | Should WhatsApp replies use the business's phrases once the hot file's owner allows it? |
| A11 | A11 | Flag gates that name nothing | A flag that names a module, entity, command or tool that does not exist stops startup. Nav hrefs are not checked on the server. | Default, fail closed: a typo would leave the feature on for everyone | None |
| A11 | A11 | Removed custom fields | Only the values a write sets are checked, so a value from a removed field stays until someone changes or clears it. | Default: removing a field must not lock records that still carry it | Should removing a field also strip its values from records? |
| A11 | A11 | Origin lookup design | Hold a copy of every verified origin per process (one query for the whole set, at most every 30 seconds) instead of a bounded LRU of misses. This removes both the memory growth and the one-DB-query-per-anonymous-request problem. | Review finding 2 (it allowed 'cache only verified hits'); default for fail-closed and bounded cost | With very many custom domains (tens of thousands), should the copy become a bounded LRU of hits plus a negative filter? |
| A11X | A11 | Who exports | Owners only by default; the application or the business can grant `data.export` to other roles | Default | Should admins (or an accounts role) export by default? Should an export need a second person's approval? |
| A11X | A11 | What an owner's export holds | Exactly what the person can list in the app, under the application's access map (the sample's owners read their own records only) | Default | Should a business export always hold every record of the business, whoever asks (a separate "whole business" reach for exports), or stay as the person sees it? |
| A11X | A11 | The assistant | Cannot start an export (no tool); it can read the job with `get-job` | Default | Should "export my data" work from the assistant, and on which channels? |
| A11X | A11 | Format | One zip with JSON and CSV per entity and a manifest | Default | Do businesses need other formats (Excel, an accounting package's import format), or separate files per entity? |
| A11X | A11 | Files on records | The archive lists file ids found on records; it does not include the files' bytes | Default | Should photos and documents on records be in the export, given their size? |
| A11X | A11 | Retention | Archives stay until "delete my data" (B11) | Default | How long should an export archive be kept (a day, a week)? |
| A11X | A11 | Notification | None: the screen shows progress | Default | Should the person be told (push, email) when the export is ready? |
| A11X | A11 | Downloads | Downloading the archive is not audited (the start and the result are) | Default | Must every download of an export be audited? |
| A11X | A11 | One at a time | One unfinished export per business | Default | Is one at a time per business right, or per person? |
| A11X | A11 | Size | `FILES_MAX_BYTES` (25 MiB by default, compressed) | Default | What is the largest business expected, and should a large export be split into several archives? |
| B1 | B1 | Production store | Any S3-compatible store, configured per deployment; MinIO in development | PRD platform-ai ('S3-compatible storage'); default | Which store and region in production (S3 ap-south-1, R2, self-hosted MinIO)? Must files stay in India? |
| B1 | B1 | Sizes and types | Per field (`accept`, `maxBytes`); deployment cap 25 MiB; SVG only when named | Gap map owner question; default | What is the largest file, and which types are allowed (photos, PDFs, CAD drawings, videos)? |
| B1 | B1 | Thumbnails and EXIF | Originals only on the server; the app re-encodes picked photos at 0.8 quality; no EXIF (GPS) stripping | Gap map (no image library in @hykr/api); default | Should photos be resized, and their location data removed, on upload? |
| B1 | B1 | WhatsApp media | Kept by default; a business can turn it off; the assistant puts it on a record | Gap statement (WhatsApp media kept on records); F5 InboundHook | Should photos and documents sent on WhatsApp be kept? Should anything be attached without the assistant (for example to the conversation)? |
| B1 | B1 | WhatsApp voice notes | Transcript only, as before; the audio is not kept | Plan hot-file table; existing privacy choice | Should voice-note audio be kept with the record, or only its words? |
| B1 | B1 | Erasure | Everything a person or contact sent is erased; records keep a dangling id | F5 decision 25; gap map | Should "delete my data" remove the files people sent from business records (it does), and should staff see that a file was erased? For staff accounts, should their uploads to business records stay? |
| B1 | B1 | Attaching another person's upload | Only the uploader can attach a file on no record | Plan; F3 write hooks | Should staff be able to attach a file a customer sent on WhatsApp to a business record themselves? |
| B1 | B1 | Retention | Removed or never-used files are deleted 7 days later | Default (allows undo) | How long should a removed file be recoverable? |
| B1 | B1 | Quotas and scanning | None | Default | Is there a storage quota per business? Is malware scanning required for files from outside parties? |
| B1 | B1 | File field representation | A file field stores file ids (uuid or uuid[]); metadata and fresh URLs come from /api/files | Plan B1 row (FileRef field type); default | None |
| B1 | B1 | Upload transport | Presigned PUT straight to storage, with content-type and content-length signed, then confirm; no multipart through the API | Gap map B1 risks (body parser conflict); plan (presign → confirm → get) | None |
| B1 | B1 | Access to files | A file is reached only through its owning record: scoped repo.find, the entity's get exposed to agents, and still listed after toRead(row, p). An unattached file is visible only to its uploader. Anything else is 404. | Plan (scoped through the owning row); task (another tenant 404, hidden fields hidden) | None |
| B1 | B1 | Local driver URLs | Relative `/api/files/blob/<HMAC token>` URLs served by the API without a session; `STORAGE_SECRET` is derived from `BETTER_AUTH_SECRET` when unset; `nosniff` and a sandbox CSP. | Default (the API's public URL is not in its config) | None |
| B2 | B2 | Who opens a rendered copy | Readers who see at least what the requester saw (roles and capabilities), unless the definition lists the capabilities that matter | Default | Should a copy someone sent to a customer be visible to every colleague who reads the record, whatever their role? |
| B2 | B2 | Snapshot | Each render snapshots its data; nothing re-reads live rows | Default | Should a re-sent document be the stored copy (today) or a fresh render? Should the snapshot ever be deleted (retention)? |
| B2 | B2 | The assistant sending | Waits for the person's approval; sending to oneself does not | Default | Which documents may the assistant send without asking (a receipt to the customer who asked for it)? |
| B2 | B2 | Recipients | A customer, a contact, a member or any email address (with `customers.message`) | Default | Should sending to an address that is not a customer or member be allowed, or need an owner? |
| B2 | B2 | Languages | The language asked for, else English; the WhatsApp template in the recipient's language | Default | Should a document default to the customer's language? Is a bilingual document (English + Hindi) needed? |
| B2 | B2 | Branding | Business name in the header; no logo, colours or signature image | Default | Is a per-business letterhead (logo, colours, signature) needed for v1 (A11 branding)? |
| B2 | B2 | A send that stopped part way | Failed `interrupted` (it may or may not have gone), never sent again | Default | Is a possible missed send better than a possible duplicate for every document, or should some (a receipt) be retried? |
| B2 | B2 | Who sees a document's sends | Everyone with `customers.message` sees all; anyone else only their own | Default | Should a customer see that their document was sent to someone else (an accountant), without the address? |
| B2 | B2 | Meta template review | A sample PDF is uploaded when `WA_APP_ID` is set | Default | Will production set the app id, or will document templates be created in WhatsApp Manager? |
| B2 | B2 | Digital signature, PDF/A | Neither; the SHA-256 is kept for B8's acceptance | Default | Must sent PDFs be digitally signed or archived as PDF/A? |
| B2 | B2 | Mandated formats | None in the framework; the application lays out its own | Default | Is there a mandated invoice format or e-invoicing (IRN/QR) to support in the application? |
| B3B5 | B3 | One currency per record | An order and all its lines share one currency, and money in another currency is refused. | Gap map B3 + task note (Money everywhere money moves) | Is a multi-currency document (lines priced in another currency and converted) ever needed? |
| B3B5 | B3 | Neutral fallback `XXX` | With no tenant currency and no `DEFAULT_CURRENCY`, money shows as `¤1,234.50`. | Task note; default | Should a deployment instead refuse to start without `DEFAULT_CURRENCY`? |
| B3B5 | B3 | Fiscal label | `{fy}` reads "2026-27" for a year starting in April 2026 and "2026" for a calendar year. Templates can already compose `{fyStart}`, `{fyEnd}` and their `:yy` forms. | Default | Is another label form wanted (`FY27`, `2026/27`)? |
| B3B5 | B3 | Rounding | The sample rounds tax per rate group, half up. | Default (sample only) | Should it be per line, and is a round-off line to the nearest whole unit wanted? |
| B3B5 | B3 | Tax-inclusive prices | The primitive supports `included` tax lines; the sample prices are exclusive. | Default (sample only) | Which does the product use? |
| B3B5 | B3 | Changing `fyStartMonth` mid-year | The running fiscal year keeps its counter under its start year's key. | Default | Should a change start a new series? |
| B3B5 | B3 | Number allocation | A number comes from a counter row upserted in the write's transaction, taken only in a command's `run` (a parked or refused write takes none). The row stays locked until the write commits, so two saves of one series in one business wait for each other. | Plan B3 row (FOR UPDATE); gap map risks | Fine at small-business scale; is a pool of pre-allocated numbers ever needed? |
| B3B5 | B5 | Children are written through their parent only | Plain CRUD cannot create a child, and moving a node between groups is a parent-level save. | Default | Should single-line edits after approval be possible (that is B4's revision question)? |
| B3B5 | B5 | Who owns a line | A line belongs to its order's owner and customer, not to whoever added it, so everyone who reaches the order reaches all its lines. | Plan hot-file table + B5 row | Confirm. |
| B3B5 | B5 | Depth and size | Trees are limited to 8 levels and 1000 nodes per save, and the JSON body to 1 MB. | Default | Are larger units expected? |
| B3B5 | B5 | Deleting a parent | The database cascades its children, and only the parent's delete is audited. The sample never deletes orders (it cancels them). | Default | Should the framework refuse a parent's delete while it has children? |
| B3B5 | B3 | Who sees amounts | `GET /api/money` returns the currency, its exponent and the fiscal start to every member, never the named amounts and bands, which only server rules read. | Default (least exposure) | Do clients need the limits to warn before saving? |
| B6B4 | B6 | Workflows are code | States and transitions are declared by modules; a business can rename nothing and add no stage. | PRD Win (pipeline board, "studio-configurable stages"); default | Should a business be able to add stages (stored per business) on top of a module's machine? |
| B6B4 | B6 | SLA durations per business | A business can override an SLA's duration or switch it off in its `sla` settings (editable since H2). | Default | Is that the right granularity, or should a business define new SLAs? |
| B6B4, B17 | B6, B17 | No working week by default | Without `businessHours`, business-hours SLAs count every hour (they fire sooner, never later) and free time offers every hour of every day, night included. A slot may run past midnight unless `hoursFrom` and `hoursTo` are given. | Default; boundary rule (calendars come from tenant settings); B17 review findings 1 to 3 | Should a business without business hours get a working-day default, and whose: a deployment setting, or a business setting required before free time answers? |
| B6B4 | B6 | Holidays are dates | Half days and per-branch calendars are not supported. | Default | Are half days or per-branch calendars needed? |
| B6B4 | B6 | Breach after the fact | A breach found when the record leaves the state (the sweeper ran late) is recorded but neither notified nor escalated. | Default | Should it still notify? |
| B6B4 | B6 | Escalation by the system | An escalation transition runs as the system principal, which cannot park. A transition whose approval would park for the system is refused and recorded on the timer. | Default | Should escalations be allowed to ask a person instead? |
| B6B4 | B6 | Readers who cannot write | A transition is tried in a savepoint before anything parks, so a reader who cannot write gets 404 instead of a request someone else would approve. | Default | Is a "request a change" flow for read-only participants wanted (B7 participants)? |
| B6B4 | B4 | Revisions are copies | v2 is a new record with its own id, and v1 stays readable, frozen. | Default | Is one record with snapshots preferred for some kinds of document? |
| B6B4 | B4 | Revision numbers | A revision's number is `<number>-v<n>` in the sample. | Default | Is another form wanted, and should a revision ever take a new series number? |
| B6B4 | B4 | What freezes | A frozen record keeps its state field movable (an approved order can still be fulfilled) and `editableWhenFrozen` fields. | Default | Can an owner re-open an accepted (approved) order, with audit, or is cancelling and starting again the only way? |
| B6B4 | B4 | Who sees versions | Everyone who may read a revision sees it in the versions list. | Default | Should a customer see only the revision sent to them? |
| B6B4 | B4 | Approval pins | A parked write fails on approval when the record's version changed at all, even for an unrelated field. | Default | Should only changes to the fields the request touches count? |
| B6B4 | B6 | Expired orders | In the sample, an order nobody decided in a week expires and can then only be revised (or left). | Default | Should expiry instead hand it back to draft, or cancel it? |
| B6B4 | B6 | Who approves | The sample's `approve` needs `orders.approve` (owners and admins); a person who holds it may approve an order they submitted themselves. | Default | Should approving your own order be refused (A5's self-approval rule)? |
| B7 | B7 | Who manages parties | `parties.manage` is owner, admin and ops. | Default | Should a staff member who owns a record put the client's family on it? |
| B7 | B7 | Who sees other participants | Only `parties.read` lists who participates in a record. | Default | Should a household member see who else is on their project? |
| B7 | B7 | Named approvers among participants | The PRD says "only named approvers approve" for family access. Here a participant role decides what a person reaches (read or write, per `as`); A5's named approvers must be members of the business. | PRD Platform & AI ("homeowners are participants, never members"); A5 | Should a participant (a homeowner) decide an approval themselves, e.g. accepting a change order? |
| B7 | B7 | Participant capabilities | Participants hold the `participant` role default's capabilities in every record. | Default | Should a participant role carry its own capabilities (a supplier may confirm dispatch, a household member may not)? |
| B7 | B7 | Cross-business parties | A supplier at two businesses is two parties; KYC is not shared. | Default | Is a platform-level supplier directory needed (B19 operators)? |
| B7, B8 | B7, B8 | Unverified email | Team and party invitations match the account's email, and B8's email codes go to it, but Better Auth does not verify emails at sign-up. | Default; B8 decision 7 | Is an unverified sign-up email acceptable for invitations and as an OTP channel, or should both wait until emails are verified? |
| B7 | B7 | Unknown senders | Default stays "every unknown sender is a customer". | Default | Should a business that works only with outside organisations default to `contact`? |
| B7 | B7 | Invitation links | The app's link is `<app>/businesses/join?token=…`, built by whoever shares it (nothing emails it). | Default | Should the API return the link, and should invitations be emailed (both kinds)? |
| B7 | B7 | Joining from a link | Opening the link fills the code in and waits for the person to press Join. | Default | Should it join at once? |
| B8 | B8 | One signer | One acceptance per document per signer; with a transition, the first one moves the record and later ones are refused. | Default (B8 decision 17) | Should some documents need several signers (both co-owners), each accepting before the record moves? |
| B8 | B8 | OTP is enough | OTP on WhatsApp or email is the acceptance; e-sign (Aadhaar eSign or a DigiLocker vendor) is an interface only. | Gap list B8; PRD Win §7.1 | Which documents, if any, must be e-signed, and with which provider? |
| B8, B18, H4 | B8, B18 | How long acceptance evidence is kept | Acceptance evidence (the address the code went to, the IP, the device) survives "delete my data": the table is append-only, the erasure counts it as kept, and the register lists it with the application's reason. Pending codes are deleted. | Gap map risk (DPDP against legal retention); B8 decision 22; H4 | How long must evidence be kept after the person is forgotten, and what may be redacted or anonymised after that? |
| B8 | B8 | No withdrawal | An acceptance cannot be withdrawn; the business cancels the record (the sample allows cancelling an approved order, accepted or not). | Default | Can a signer withdraw an acceptance, and what happens to the frozen record then? |
| B8, H5 | B8 | An accepted order's state | Resolved by H5: the sample's order moves to `accepted` (frozen) when its customer accepts it, so lists and fulfilment tell it from one only approved. | Default | Settled by H5. |
| B8, H5 | B8 | One PDF, accepted once | Without a transition, a signer accepts each PDF of a record once; a new PDF of the same version could be accepted again (a second evidence row). The sample's orders cannot: an accepted order refuses a later PDF (`order_accepted`, H5). | Default | Is that the rule for every acceptance, or only for those with a transition? |
| B8 | B8 | Who sees the evidence | The full evidence (address, IP, device) is for `acceptances.evidence` holders (owner and admin); colleagues who reach the record see that it was accepted, by whom and when. | Plan (hidden fields stay hidden); boundary rule (capabilities, not roles) | Is that the right split for disputes? |
| B8 | B8 | A stale PDF is refused | A PDF made before the record's last write (even a state change) is refused: make it again. | Gap map risk (a hash without frozen versions); B8 decision 6 | Should a state change alone keep a PDF current? |
| B8 | B8 | Behind a proxy | The IP recorded is what Express sees. Production behind a load balancer needs `trust proxy` configured, which this unit does not add. | Default (B8 decision 21) | Which proxies does production run behind? |
| B8 | B8 | Acceptance tools for the assistant | The assistant cannot ask for a code or accept (`humans_only`), and has no tool to read acceptances. | Default (fail closed); PRD Win §7.1 (the legal act is the person's) | Should the assistant get a read-only tool for a record's acceptances? |
| B8 | B8 | Repeating an accept | A used or expired code returns `no_code` before any write, unless the request carries an idempotency key: then `runWrite` replays the stored result or refuses with `no_code`. | Default (keeps the write path's idempotency) | Is one short transaction for a repeat with a used code acceptable? |
| B9 | B9 | Every link expires | At most 90 days by default; a form posted on a website must be linked again when its link ends. | Gap list ("expiring"); default (fail closed) | Should a business be able to publish a form without an end date? |
| B9 | B9 | Who may share | Anyone on the team (owner, admin, ops, staff) who reaches a record may share it; revoking others' links is for owners and admins. | Default; boundary rule (capabilities, never role names) | Should sharing need its own role, or an approval (a level) for some records? |
| B9 | B9 | A page is shared as its maker sees it | A shared page shows its blocks with the maker's reach but none of their capabilities. | Gap list ("share link to a record or page"); default | Is that the right reading of "share my page", or should pages be shared only when every block is about one shared record? |
| B9 | B9 | An anonymous submission makes a customer record | A web form with no recipient creates a customer per submission (named by the form's name field), like an unknown WhatsApp sender. | Developer guide 6.2 (a customer's create is owned by the default owner); default | Should submissions be matched to existing customers (by phone), or wait as leads without a customer? |
| B9 | B9 | One recipient per link | A link has one recipient (the code's destination and the signer). | Default | Should a family share one link with several numbers? |
| B9 | B9 | Signing needs a WhatsApp contact | A guest signs only as a contact (the recipient's number); an email-only recipient can open a gated link but cannot accept. | B8 decision 7 and its Deferred item; default | Should email recipients sign too (a signer kind for guests in the evidence)? |
| B9 | B9 | No assistant | The assistant can neither make nor send a link. | Default | Should "send Asha the order link" be a tool (it would then need an approval level)? |
| B9 | B9 | Links are not sent | The person making a link copies it; the framework does not send it on WhatsApp or by email. | Default (as invitations, A4) | Should making a link optionally send it to the recipient (a template)? |
| B9 | B9 | A session lasts 12 hours | After the code, a device sees the link for 12 hours (or until the link ends). | Default | Is that right for a client page opened over several days? |
| B9 | B9 | Guest reach outside access maps | Guests read only through the share grant that `accessFor` gives itself, scoped by `defineShareable`, whatever an entity's access map says; a form submitter gets only the customer write grant. | Plan (a share grant); hot-file table; default (fail closed) | Should an application also be able to write the share grant into its access maps? |
| B9 | B9 | Guest writes never wait | A guest write that would park is refused (`guest_cannot_wait`) and audited: nobody could be asked on its behalf, and a replay would have nobody to act as. | Default (fail closed) | Should public submissions be able to wait for a team member's review before the record exists? |
| B9 | B9 | Briefs as a sample module | The brief questionnaire is a new sample module, `briefs`, rather than an entity inside orders. | Plan hot-file table (the orders entity files were others') | Should a brief later seed an order? |
| B10 | B10 | Who manages integrations | Owner and admin (`integrations.manage`). | Default (like channels.manage); decisions B10 #7, #27 | Should other roles (an operations or accounts role) manage them, or only see the delivery log? |
| B10 | B10 | Signature scheme | Standard Webhooks (`webhook-*` headers, `whsec_` secrets). | Default; decisions B10 #3, #9 | Is there a receiver (an accounting tool, a marketplace) that needs another scheme? |
| B10 | B10 | Which events leave | Every entity's events, unless the entity opts out with `traits: { webhooks: false }`. | Default, fail closed for records nothing can project; decisions B10 #10 | Should it be opt-in per entity instead? |
| B10 | B10 | Rows an endpoint reads | An endpoint reads every record of its business and capabilities only hide fields. So `integrations.manage` lets a person send every record of the business elsewhere (and read it in the delivery log), even one their own row access would not show them: give it only to roles that may read the whole business. | Default; decisions B10 #12 | Should an endpoint instead be limited to the rows its creator can read, or to chosen entities? |
| B10 | B10 | Retries | 8 attempts over about 27 hours, then `failed`, with no automatic pause of an endpoint that keeps failing. | Default (Standard Webhooks recommendation); decisions B10 #15 | Is that right, and should a business be told when an endpoint fails? |
| B10 | B10 | A try that did not finish | A worker that dies mid-send (or cannot save the result) uses up that try: the receiver may have got it, so the next try can repeat it (same `webhook-id`), and the delivery can end `failed` one try early. | Review finding fix (2), first option; default fail-closed | Is at-least-once with a counted lost try right, or should a lost try be retried without counting it (risking a delivery that never ends)? |
| B10 | B10 | No order | Deliveries of one record's events can arrive out of order (retries, parallel workers). | Default | Does any receiver need per-record order? |
| B10 | B10 | Payload | The record, the record before (updates and deletes), the event name and time. No actor. | Default, least data; decisions B10 #14 | Should receivers learn who made the change (person, assistant, system)? |
| B10 | B10 | HTTPS only | Plain `http` is refused except for hosts in `INTEGRATIONS_ALLOWED_HOSTS`. | Gap map SSRF risk; decisions B10 #6 | Is any receiver on plain http in production? |
| B10, S2 | B10 | Replay window for inbound requests | A request whose signed timestamp is more than 300 s away is refused (Standard Webhooks' tolerance; `toleranceSec` per connector). | B10 decision 3 (Standard Webhooks); S2 task note | Should a business be able to change it for a sender with a skewed clock? |
| B10 | B10 | Per-connection inbound URLs | Each connection has its own URL. Providers that send every account's events to one URL per app need routing by account id (deferred, decision 20). | Default (fail closed); B10 decision 20 | Which providers need one shared URL per app, and how should a business prove it owns an account id? |
| B10, S2, H4 | B10, B18 | Integration log retention | Deliveries, attempts and inbound events stay until their endpoint or connection is deleted; no retention target covers them (H4). A sender that signs no timestamp can have a captured request posted again later, and only its stored key drops it. | Default; left to B18 | How long should integration logs be kept? If a period is added, should inbound keys outlive the event data, or should connectors without a timestamp be refused? |
| B10 | B10 | Previous secret | A rotated endpoint secret keeps signing for 24 hours. | Default; decisions B10 #3, #9 | Is 24 hours long enough? |
| B10 | B10 | Capabilities taken away | Each try sends what the endpoint may read at that moment and the log keeps it, so fields taken out of an old delivery do not come back if the capability is given back. Only someone holding every capability an endpoint reads with may retry its deliveries or move it. | Review fix round 1; default (fail closed) | Should a business be able to resend old deliveries in full after restoring a capability? Should any manager be able to retry a delivery to an unchanged URL? |
| B10 | B10 | Inbound handler failures | A 4xx refusal (another business's record, a missing capability) fails the event for good; nothing tells anyone except the inbound log. | F4 decision 20; decisions B10 #21 | Should a failed inbound event notify the people who manage integrations? |
| B10 | B10 | Who may change an endpoint's capabilities | Changing the URL or the capabilities requires holding the union of the old and new capability sets, so removing a capability you do not hold is also refused (deleting or pausing the endpoint still needs only integrations.manage). | Review fix round 1 (require the union when the URL changes), extended to capability changes to block the two-PATCH split at the authorization layer too | Should a manager without a capability be able to remove it from an endpoint (narrowing only) without deleting the endpoint? |
| B10 | B10 | Deliveries whose record may no longer leave | A stored delivery whose entity no longer sends webhooks (it opted out or was removed), or whose body does not parse, is cancelled at send time instead of being sent. | Default: fail closed | None |
| B11 | B11 | Who may start a job | The application's own command decides (role, capability, approval); the framework only checks reach | Default | Should outside compute (renders, plan reading) need an approval, or a credit check (A3), before it starts? |
| B11 | B11 | Results onto records | Results stay on the job; `complete` copies what a record should show | Default | Should a result ever change records with no one reviewing it first? |
| B11 | B11 | Who sees a job | Whoever reads its record; the starter for jobs about no record | Default | Should owners and admins see every job of the business (an operations view)? |
| B11 | B11 | Cancelling | People only; the starter or someone who may edit the record | Default | May the assistant cancel a job it started? |
| B11 | B11 | Deadlines | Declared per kind; the framework has no default | Default; the PRD gives the expected durations | What are the expected durations (the PRD: Blender stills 2–14 minutes, plan reading 99–258 seconds)? |
| B11 | B11 | Notifications | None; events exist | Default | Should the person be told when a job finishes (push, WhatsApp, in-app)? On which channel? |
| B11 | B11 | Erasure | Jobs about no record are erased; jobs about a record stay | Default | Is a job's input (a floor plan, a brief) personal data of the person who started it? |
| B11 | B11 | Retention | Jobs and their result files are kept until erased | Default | How long should finished jobs and their results be kept? |
| B11 | B11 | Callback scheme | Our own signature header by default; per-kind `verify` for a provider's | Default | Which providers (render farm, vision model) are planned, and how do they sign webhooks? |
| B11 | B11 | Submitting twice | A submission that threw, or was cut off by a worker that stopped, is submitted again until `submit` returns; kinds pass `ctx.job.id` to their service as an idempotency key where it takes one | Default | Can the planned services take an idempotency key, so that a submission cut off after the service accepted it is not run (and billed) twice? |
| B12 | B12 | Opt-in per spec | Only entities and commands whose module says so are queued offline. | Gap map extension point (spec opt-in); default (fail closed) | Should every entity be capturable offline by default? |
| B12 | B12 | People only choose ids | The assistant, MCP clients and the server's own work never choose a record's id. | Gap map risk (create strips the id); default | Is there a client (an integration) that should? |
| B12 | B12 | One conflict answer | A stale `If-Match` answers 409 `stale` (as B4's body version does), not RFC 9110's 412. | Gap list (conflict → 409); B6B4 decision 19 | Do outside clients need 412? |
| B12 | B12 | Conflicts are whole-record | Any change to the record since the person saw it makes their queued change conflict, even on another field. | Gap map owner question; default | Should only the fields it changes count (per-field merge)? |
| B12 | B12 | Replies kept 30 days | A device offline longer than `IDEMPOTENCY_KEEP_DAYS` may apply a queued update twice if its first try reached the server (creates are safe through their ids). | Gap notes (idempotency TTL); default | Is 30 days right, and should the app refuse to sync items older than that? |
| B12 | B12 | Parked items leave the outbox | A write that parks on sync is shown once (a toast) and then lives on the approvals card. | Gap list (writes needing approval park on sync) | Should the pending list keep it until it is decided? |
| B12 | B12 | Sign-out keeps unsynced items | They stay on the device for the same person and sync after they sign in again (the cached data is removed). | Gap map risk (queued writes survive a new sign-in); default (never lose captured work) | On a shared device, should sign-out warn, or discard them? |
| B12 | B12 | An expired session found on reconnect | The shell shows the sign-in screen and drops what the person read from memory; their persisted cache is not removed on purpose (only an explicit sign-out runs the plugins' `onSignOut`), and their unsynced items wait for them. | Review finding 1; default | Should a session the server refuses also forget the person's cached data on the device? |
| B12 | B12 | Cached data kept 7 days | The persisted cache holds what the person read (projected for them) for a week, on the device, until sign-out. | Default | Is that acceptable under the business's data policy, and should a business be able to switch it off? |
| B12 | B12 | Files offline | A photo taken offline is not queued (B1 uploads need the network). | Default | Which flows need offline photos first? |
| B12 | B12 | Which flows | The PRD names site capture (daily reports, photos, material requests). The framework makes any entity or command capturable; which of the product's modules opt in is the product's choice. | PRD (site capture: daily reports, photos, material requests) | Which of the product's flows should opt in first? |
| B12 | B12 | Undo and versions | Undo (A5) compares a record's content, ignoring the version counter and `updatedAt`, so a create whose later change was undone can still be undone. | Default; found by the sample's undo test | Should an undo refuse when only the version moved? |
| B12 | B12 | How a used id is found | Any committed audit row of the entity naming the id makes it `id_taken`, forever and in any business. Comments, call logs and acceptances are not cleaned up when a record is deleted. | Review finding 1 (its suggested fix) | Should deleting a record also remove its comments and call logs, or is keeping them (reachable only through a live record) intended? |
| B12 | B12 | Records written outside the write path | A record inserted without an audit row (a seed, direct SQL) and removed without one could have its id chosen again. | Default; CLAUDE.md design rule 1 | Do any imports or seeds insert offline-capable records outside `runWrite`? |
| B12 | B12 | A parked create with a spent id | The id is checked when the row is inserted, so such a create parks and its approval then fails with 409 `id_taken`. | Default (nothing leaks) | Should a parked create's id be checked when it parks, before an approver sees it? |
| B13B14 | B13 | Check-in radius | The sample allows check-in within 200 m of the meeting's point, and only with a fix at least as precise. | Default | Which radius do sites need, and should it be per site, per business (a setting) or per record? |
| B13B14 | B13 | Accuracy | A fix less precise than the radius is refused rather than accepted with a warning. | Default | Is that too strict for weak signal indoors? |
| B13B14, B18 | B13 | Location as personal data | Check-ins keep the person's point until the record is deleted, or until the module lists its location field in the record's `privacy` trait (B18). | Default | Is a privacy notice in the app enough for the pilot? |
| B13B14 | B13 | Continuous tracking | Only point-in-time check-ins exist. | Default | Is tracking during a visit wanted? |
| B13B14 | B13 | No server geocoding | Addresses are typed or found by the phone's geocoder; the server never calls a geocoding service. | Default | Is a server geocoder (and which provider) needed? |
| B13B14 | B13 | PostGIS on managed Postgres | The hook needs PostGIS installed, or a role that may create it. | Default | Will production run on a provider that offers PostGIS? |
| B13B14 | B14 | Projection per reader | The field-hiding check assumes a projector hides a field from a reader on every record alike (A4's field policy does: it goes by capability). A projector that hides a field on some records only would let a summary over that field through. | Default | Is any such rule planned? |
| B13B14, A4 | B13 | Filters on hidden places | Until A4 lands, nothing refuses a list filter on a field a projector hides, so someone who cannot see a record's point could still find it with `location[near]`. A4's field-policy `query` hook refuses filters on hidden fields for every type, `geo` included. | Default | Settled by A4: its field-policy `query` hook refuses filters on hidden fields, `geo` included. |
| B13B14 | B14 | kpi.row in the chat | `kpi.row` now shows inline in the app's chat (it was canvas, text and speech only), so the summarize tool's tiles appear under the answer. | Default | Is that the wanted look? |
| B13B14 | B14 | One summary tool per entity | Every entity whose list the assistant may call gets a `summarize-<plural>` tool. | Default | With many entities, should the assistant get one generic tool, or per-module tools (A1)? |
| B13B14 | B14 | Groups and buckets | At most two group fields and 200 groups; weeks start on Monday (ISO); months, quarters and years are calendar ones in the business's time zone. | Default | Are fiscal quarters (from `fyStartMonth`) wanted? |
| B13B14 | B14 | Summaries over filterable fields only | A field is summarized only if it is filterable. | Default | Should a spec be able to allow or forbid summaries separately? |
| B13B14 | B14 | Staff see their own | Under `own` grants a staff member's summary covers only their rows, like their lists. | Default | Should owners give staff business-wide numbers without their rows? |
| B16 | B16 | Who may comment | Anyone who can read a record, customers included (PRD family access). | PRD Design §7 family access ("extra participants can view and comment") | Should some entities be read-only for comments for customers, or should commenting need write access to the record? |
| B16 | B16 | Internal comments | Hidden from everyone without `comments.internal` (by default the team roles). | Default | Is "team only" the right default name and audience? Should internal be the default for staff? |
| B16 | B16 | The @-picker for customers | A customer who comments on their own record is offered the business's people who may read it (names only). | Default | Should customers be offered only people already in the discussion, or nobody? |
| B16 | B16 | Mentioning someone who cannot see the record | Mentioning someone who cannot see the record refuses the comment. | Default | Should it instead keep the comment and skip that person (and say so)? |
| B16 | B16 | The assistant's comments | It may add comments for its person (no approval unless the entity's trait asks), but not edit or remove them. | Default | Is that right? |
| B16 | B16 | Edits that wait | An edit waits whenever the same comment, added now, would (decision 25), including an edit that only fixes a typo. | Default (B16 decision 25) | Should a business be able to let small edits of an approved comment run (no new mentions, a short change), or is approval per edit right? |
| B16 | B16 | Mention notifications | The framework only fills the in-app inbox; push, WhatsApp and email are each application's choice. | Default | Should a mention count against credits (A3) when it goes out? |
| B16 | B16 | Removing | Removing deletes the comment (the audit keeps its text). | Default | Should removed comments leave a "removed" line in the discussion instead? |
| B16 | B16 | Erasure | Mentions of an erased person become `@—`. | Default | Acceptable, or should the token stay with a neutral label? |
| B16 | B16 | Attachments, reactions, threads | Not built (see Deferred). | Default | Which matter for P1 (photos on a site comment?) |
| B17 | B17 | Google only | Microsoft 365 (Outlook) is not built; the connector shape (OAuth, upsert, changes, free/busy) is what a second provider would implement. | PRD Win §7.1 ("Google/Outlook"); default | Is Outlook needed for the first version (PRD Win 7.1 names "Google/Outlook")? |
| B17 | B17 | One way | Records go to Google; changes made in Google are reported as events and the application decides (the sample moves the meeting). | Default | Should the framework instead overwrite Google with the record, or always accept the calendar's time? |
| B17 | B17 | Whose calendars | The trait's `people` columns (default the owner). | Default | Should every member who can read a record get it, or should participants (B7) be invited automatically? |
| B17 | B17 | Primary calendar | Events go to the person's primary calendar. | Default | Should a person pick a calendar, or should the framework make a dedicated one? |
| B17 | B17 | Invite replies | Attendees' accept/decline replies are not read (no inbound mail); RSVP is off. | Default | Is tracking replies needed? |
| B17 | B17 | Automatic invite updates | A change to an invited record emails every recipient an update. | Default | Should a person confirm updates to external recipients first (they are sends to others)? |
| B17 | B17 | Feed scope and window | A feed shows the person's own records, 90 days back to a year ahead. | Default | Should a manager have a team feed? |
| B17 | B17 | Who reads others' availability | `calendar.availability.read` (owner, admin, ops). Only busy times, never titles. | Default | Is that right? |
| B17 | B17 | Calls about no record | Visible to who logged them, the member on them and `calls.read_all`. | Default | Is that right? |
| B17 | B17 | Recordings | Not stored. | Default | Are recordings needed, with consent and retention (B18)? |
| B17 | B17 | How long a calendar job waits | A job waits up to 60 s for a lock connection and 60 s for another job of the same record or invite, then fails and retries; at most 4 jobs per process hold or wait for a lock at once (decision 33). | B17 review finding 4; default | Are these right for the expected load (a backfill of 500 records, Google's push notices for each of our own changes)? |
| B17 | B17 | A failed invite is an event | `calendar.invite_failed` is stored, but nobody is told. | Default | Should the person who asked be notified (an in-app item or an email), or is the invite's state on the record enough? |
| B17 | B17 | Signing in from another device | A sign-in finishes only in an app signed in as the person who started it, in the same business (decision 36). Someone who starts on the phone and finishes consent in a desktop browser where they are not signed in has to sign in there first, or start again. | Default (B17 decision 36); RFC 6749 §10.12 | Is that acceptable, or should the app keep the code across its sign-in screen? |
| B17 | B17 | Telling the person who was sent someone else's link | The refusal says "someone else started this calendar sign-in" (403), not a plain 404, so the person can tell they were sent a link they should not trust. The pending sign-in is a short-lived nonce written outside `runWrite`; a refused completion is logged as a warning, not audited. | Default (B17 decision 36) | Should a refused completion also notify the business's owners, or be an audit row? |
| B17 | B17 | Connection timeout of the shared pool | `createDb` waits at most 30 s for a connection (overridable per call); this applies to every user of the shared pool (Nest, Better Auth, queues). Calendar jobs use a separate 4-connection pool for advisory locks. | B17 review finding 4; default | Should the timeout be a deployment setting? |
| B17 | B17 | Where a Google sign-in completes | Google's callback only forwards the code and state to the app, and `POST /api/calendar/google/complete` runs under the app's session; any completion attempt uses up the pending sign-in. A native app returns through `CALENDAR_APP_RETURN_URL`; a request chooses only between the deployment's two addresses. | Review finding; RFC 6749 §10.12; default (no open redirect) | None |
| B18 | B18 | Fiduciary and processor | Each business is the fiduciary of what it holds; requests are per business; the login is erased only when the person is in no business | PRD Overview §7.4 (the business is the fiduciary, the platform the processor) | Is that the lawyer's reading? Must the platform also answer requests for the account itself (a "delete my account" across businesses)? |
| B18 | B18 | Review | Own requests run at once unless the business reviews that kind; staff-filed ones run at once | Default | Must every erasure be reviewed by a person first? Must a person's identity be checked again (OTP) before an export is released? |
| B18 | B18 | Deadline | The sample answers within 30 days; no deadline unless declared | Boundary rule (SLA durations belong to the application); default | What deadline do the rules set (and should it count business days)? Who must hear when it is close, not only when it passed? |
| B18 | B18 | What erasure deletes | The module decides per entity: delete, anonymise, or keep with a reason | Gap map extension point; default | Which record types must survive erasure for tax and legal reasons, for how long, and anonymised how? |
| B18 | B18 | Membership | Erasure removes the person's membership in the business; the business's default owner cannot be erased (403 `default_owner`). | Default | Can a current team member be "forgotten" without leaving? |
| B18 | B18 | Export format | One zip of JSON, personal fields only | DPDP (a summary of the data); default (data minimisation) | Is JSON acceptable, or is a readable (PDF) summary needed? Must files (photos) be included in the copy? |
| B18 | B18 | Retention | Periods only where declared; the sample keeps raw WhatsApp payloads 30 days, archives 90, notes two years after their last change | Boundary rule (the old 30 days moved into the sample) | What periods apply to leads that never converted, quotes, invoices, photos, chat transcripts, call recordings? |
| B18 | B18 | Copies we do not reach | Redis job payloads and BullMQ's kept jobs, other people's conversation messages that quoted the person, backups | Gap map risk; default | Is a purge of kept jobs (and a backup expiry policy) needed? |
| B18 | B18 | Consent | Unchanged (service, reminders, marketing) | Default | Which more purposes, and is a Consent Manager integration expected? |
| B18 | B18 | Breach log | Not built | Default | Must the platform record personal data breaches and notify the Board and the people affected? |
| B18 | B18 | Who changes the privacy settings | `privacy.manage` (owners and admins by default), people only, at once (no approval) | Fix instructions (`privacy.manage` or `settings.manage`); default | Should changing a period or the deadline wait for a second person, or be limited to the owner? |
| B18, X2 | B18 | The privacy contact | A business's contact is its own `grievanceContact`, else the deployment's `DEFAULT_GRIEVANCE_CONTACT`, else none: the register shows null and WhatsApp's HELP says that no contact is named (X2 removed the framework's placeholder). The sample names one in `application/.env.example`. | PRD Overview §7.4 (each business is the fiduciary); X2 boundary fix | Must a business name its grievance officer before it goes live (onboarding refuses, or the back office warns)? Should a multi-tenant deployment refuse `DEFAULT_GRIEVANCE_CONTACT`? |
| B18 | B18 | Shortening a period | A shorter period applies at the next daily run, to data already kept | Default | Must shortening a period wait (a notice period) or ask for a confirmation in the back office? |
| B18 | B18 | Filings after erasure | A filing about an erased person keeps its kind, intake and their id, without the email, number or note | B18 decision 14; review fix | Is the id enough evidence of whom a request was about, or must the filing keep nothing that links to the person? |
| B18 | B18 | A privacy tool for the assistant | None: requests are filed by people (the app, the back office, WhatsApp's keyword). | Default (erasure cannot be undone) | Should the assistant be able to file a privacy request? |
| B18 | B18 | Mastra's stores | Spans, logs, scores, metrics, feedback and workflow snapshots of the person's runs are deleted by SQL, each table skipped if Mastra has not created it. Mastra memory keyed by subject goes only with a contact or a person's last business. | Gap map risk | Does any other Mastra store need erasing? |
| B18 | B18 | Periods a business may set | Only per-business retention rules and targets; deployment targets (assistant traces, raw inbound payloads) and unknown names are refused with 400. | B18 decision 18; default (fail closed) | None |
| B18 | B18 | Stored idempotency replies | Treated as copies of records: erasure and retention redact erased records' fields in them. Nothing trims them by age. | Default (the client sends a key with every write) | None |
| B19 | B19 | Consent, not free access | Operators never read a business's data without its consent (decision 9). | Gap map owner question; gap statement (consented, time-boxed, audited) | Is there a case for break-glass access without consent (a legal request, an outage), audited and announced afterwards? |
| B19 | B19 | Who consents | `support.consent` is the owner's by default. | Default | Should admins consent too, or should a consent need two people? |
| B19 | B19 | Default limits | Read-only by default, 8 hours at most, a request expires after 72 hours. | Default | Are these the right defaults for the pilot? |
| B19 | B19 | Withheld capabilities | Support never holds capabilities that change who reaches the business, or exports all of its data (decision 10). | Default (B19 decision 10) | Should data export be allowed with consent? |
| B19 | B19 | Provisioning needs an account | Operators provision a business for someone who signed up (decision 15). | Gap map; plan migration rule (no NOT NULL drop) | Should operators invite an owner by email before they have an account? |
| B19 | B19 | Who publishes shared rows | By default the platform business's members still publish them, as in A11; an entity opts into operators only (decision 18). | A11 decision 16; gap statement | Should operators-only be the default for every shared entity? |
| B19 | B19 | Routing content | The routing log keeps what happened to a request, not what it said. | Gap statement (no routing rules) | Should the platform keep unrouted requests (for an operator to assign by hand)? |
| B19 | B19 | Usage report | Credits as recorded, no money prices. | Gap statement (A3 ledgers, no plans or prices) | Is a CSV export or a per-day breakdown needed? |
| B19 | B19 | Bull Board in production | It stays off in production even for operators. | Gap map risk; default | Should operators have it there? |
| B19 | B19 | Provisioning without a key | With an idempotency key, a new business's id is a UUIDv5 of the operator and the key, so a repeat returns the stored answer; without one it is random. | Review finding 1; B19 decision 15a | Should provisioning require an idempotency key, so a client cannot make duplicates by leaving it out? |
| B19 | B19 | What the support log holds | Every request whose principal ends up as support, refusals by later guards included. A request refused before the principal is known (no session, unknown business) cannot be tied to a grant and is not logged. | Review finding 2 | None |
| B20 | B20 | Who may import | `imports.run`: owners and admins | Default (fail closed); B20 decision 4 | Should managers (or a dedicated role) import? Should an import ever need the owner's approval by default? |
| B20 | B20 | Rows that need approval | Reported `needs_approval`, never parked | Default (fail closed); B20 decision 7 | Should an approved import approve its rows (one approval for the whole file)? |
| B20 | B20 | Who owns imported records | The importer (the write path's ownership) | Default (`define-entity.ts` is a hot file B20 does not own) | Should an import set each record's owner from a column (an email per row)? It needs the entity repository to accept an owner (a hot file today). |
| B20 | B20 | Deleted records | A re-run does not bring them back (`not_found`) | Default (fail closed); B20 decisions 8, 21 | Should a re-run re-create a record someone deleted? |
| B20 | B20 | Required key | Every row needs an id from the other system | Gap list (external-id mapping for idempotent re-runs) | Is there data with no ids at all (a hand-made spreadsheet)? Should such rows be imported once, with no re-run protection? |
| B20 | B20 | Empty cells | Leave the field out (`--empty null` to clear) | Default | Should an empty cell clear a field on a re-run by default? |
| B20 | B20 | Limits | 50 000 rows per file, 100 per batch, 4 hours (`IMPORTS_MAX_ROWS`, `IMPORTS_BATCH_SIZE`, `IMPORTS_REPORT_ROWS`, `IMPORTS_TIMEOUT_S`); the file's size is capped by `FILES_MAX_BYTES`. | Default (per-deployment settings) | Are larger migrations expected (the PRD's D1 move of pros, projects and leads)? |
| B20 | B20 | The assistant | Cannot start an import (reads its job) | Default | Should the assistant import a file someone sends on WhatsApp, after a dry run and an approval? |
| B20 | B20 | Map retention | Kept as long as the business | Default | Should the map be dropped once a migration is signed off? |
| B20 | B20 | Write path, row by row | Every row goes through `runWrite` with the entity's own create or update; one audit row per record. A batch `insertMany` was rejected: level rules on `<entity>.create` would not see it. | Plan B20 row; CLAUDE.md rule 1 | Is one audit row per record acceptable for large imports? |
| B20 | B20 | Dry run | Runs every batch as a real run, then rolls it back; refused writes stay audited as denied, like any refused write. | Gap list (`--dry-run`) | Should a dry run's refusals be left out of the audit? |
| B20 | B20 | Imports and storage | `basecamp import` refuses `STORAGE_DRIVER=memory`, because the worker that runs the job could not read the file. | Default | None |
| H1 | A5 | Inbox always, not a fallback step | The approval request always lands in the decider's inbox and reaches them by the first of push, WhatsApp and email that works (decision 6). | Task; PRD Platform & AI §7.1 (push, WhatsApp, email); A5 decision 25 | Should a pushed request skip the inbox, or should the inbox item go when the request is decided? |
| H1 | A5 | WhatsApp without buttons | A request decided in the app only does not go to WhatsApp at all; the decider gets push or email (decision 7). | Task; default | Should it go to WhatsApp as a plain message with a link, which needs a new template? |
| H1 | A4 | Recipients who cannot read the record | The words leave out what a recipient may not read, but the dispatcher does not check that a recipient may read the record at all: `to` decides who. | Default | Should a notification about a record skip a recipient who cannot open it? |
| H1 | A4 | Internal columns | The words no longer see the record's columns that its read schema does not show (its owner, its customer). | Default (fail closed) | Should a notification be able to name an internal column in its words? |
| H1 | A5 | Undone writes and reminders | A reminder is scheduled only when the write's undo window closes (the sample's to-dos: 10 seconds). | Task (side effects wait until the undo window closes) | Is a reminder due within the window acceptable to lose? |
| H1 | A5 | Requests the person decides | The requester's own (their assistant's) request is not notified; it is asked in the conversation. A background agent's request then shows only in the app's approvals. | A5 decisions 14 and 25 | Should it be pushed to the person too? |
| H1 | A5 | Outcome to a person | The outcome is still told only to a contact who asked on WhatsApp. A team member whose request someone else decided learns it in the app. | Default | Should they be notified? |
| H2 | A4, A5 | Who edits which section | Every framework section but `members` is `settings.manage` (owners and admins); `members` is `members.manage` (owners and admins by default, and any role a business gives it). | Default | Should approval thresholds and approvers need the owner alone, or a second person's approval (a level rule on `settings.section` does this today, per application)? Should the invitation lifetime need `settings.manage` as well? |
| H2 | A5 | Loosening approvals | A settings manager can set `parks: false` on a level that allows it (`tenantMayLoosen`), lengthen undo windows and expiries, and change who approves which band. | Default | Should loosening a level, or naming oneself as a band's approver, need another person? |
| H2 | F4 | Base defaults | The base settings' defaults are F4's (quiet hours, reply time, one marketing message a week); since X2 a business's time zone falls back to the deployment's `DEFAULT_TIME_ZONE`, else UTC. | Default | Should a new business be asked for its time zone at sign-up instead? |
| H2 | B6, A5 | Reading settings | Only the people who may change a section read it here. | Default | Should members see the business hours and SLA durations (for countdowns), and customers the reply time? |
| H3 | A1 | Writes are "open world" | Every `<module>_write` says `openWorldHint: true`, because a write can notify people outside the business or fire a webhook. | PRD Platform & AI (tool layer: "flagged read-only or consequential") | Should a module say it never reaches outside (a closed write), so clients ask less? |
| H3 | A1 | Destructive is declared, not inferred | Only deletes, HTTP `DELETE` commands and actions the application marks `destructive` make a write tool destructive. A command that cancels or sends without the mark is not. | Default | Should a parked level (the application's "irreversible") also count? |
| H3 | A3 | Agent requests while paused | Every agent request is refused when paused, reads included, for the assistant, agent runs and MCP clients. | Default | Should reads stay open (they cost a tool call each)? |
| H3 | A3 | Token limits and MCP clients | A token limit pauses the assistant's tool calls, not an MCP client's (it spends none of our tokens). The credits budget pauses both. | Default | Confirm. |
| H3 | A3 | A customer crossing the cap | A customer crossing the cap mid-turn hears the paused sentence once; the handoff happens on their next message. | Default | Should the turn hook's `after` open the handoff at once? |
| H3, S4 | A3, A8 | A meter for embeddings | Embeddings have a meter of their own, `embedding_tokens`, with the embedding model as the variant (S4), so chat prices and limits never apply to them. H3 had priced them as `tokens`. | S4 task notes (either shape allowed); default | Should embeddings share the `tokens` meter and limit with the assistant's turns? |
| H3 | A8 | The indexer and a paused business (H3) | The indexer waits a minute before it looks at a paused business again. Its pending rows are embedded once the business has credits. | Default | Confirm. |
| H3 | A3 | Settling needs the provider's name | A provider whose webhook does not carry our purchase id has to look it up by its own reference first; there is no lookup by provider reference yet. | Default | Confirm. |
| H4 | B18 | A member's calls | Unlinked; their own number goes; the notes stay | Default (H4 decision 5) | When a team member is forgotten, must the notes they wrote on calls go too, or are they the business's? |
| H4 | B18 | Which number is the member's | `from` on outbound calls, `to` on inbound ones | Default | Is the member's side always that one, or does the provider's line sit there instead? |
| H4 | B18 | Invites to the person | Deleted: no update or cancellation reaches them later | Task ("anonymise or delete"); H4 decisions 3, 4 | Should a cancellation be sent first, so the event leaves their calendar? |
| H4 | B18 | Inbound payloads | Emptied when they wrote an erased record; values equal to the email or number nulled | Task; H4 decisions 6, 7 | Do any connectors send personal data that matches neither (names, formatted numbers) and so needs a connector-specific redactor? |
| H4 | B18 | Google clean-up | After the commit, best effort, logged | B17 disconnect behaviour | If revoking the Google grant fails, must someone be told so they can revoke it by hand? |
| H4 | B18 | Clients a person registered | Kept (they are anonymous: dynamic registration) | Default (A1 tokens) | Must a client registered by a forgotten person be deleted too? |
| H5 | B10 | Placed when accepted | An order is sent to outside systems (`order.placed`) when its customer accepts it, not when the business approves it, and an order with no customer is never placed. | Default; B8 decision 17; PRD Build (suppliers receive purchase orders) | Should approving an order without a customer place it too? |
| H5 | B8 | Fulfilling without acceptance | People may still fulfil (or cancel) an approved order that was never accepted in the app. | Default | Should fulfilment wait for acceptance? |
| H5 | B10 | A supplier reports only on accepted orders | The supplier's `order.fulfilled` is refused for an order that is only approved. | Default (fail closed) | Is that right, or may a supplier report on any order it is on? |
| H5 | B10 | One connection per supplier | A connection names one party, and the business types the shared secret. | Default | Should the server make the secret (and the supplier be chosen separately)? |
| H5 | B10 | Fulfilled is the only report | A supplier's acknowledgement and dispatch (PRD Build, vendor portal) have no state yet; only `order.fulfilled` moves an order. | Task note; PRD Build (supplier portal is P2) | Which supplier events should the orders module take, and what should each do? |
| H5 | B10 | Whole order in the event | `order.placed` carries every line (up to 1000 nodes) in one stored event and one delivery. | B10 decision 11 (`eventFor` parses with the read schema) | Is a size limit or a summary needed for very large orders? |
| H6 | Docs | Webhook payloads in a person's copy | A person's copy (B18) holds their records but none of the integration bus's own rows: stored delivery bodies and inbound payloads that mention them are not in it. | Default (H6 decision 9) | Should a data-principal export include the stored delivery bodies and inbound payloads that mention the person (decision 9)? |
| H6, HDOCS | Docs | Keeping the tutorials in step | H6 corrected the tutorial where it contradicted merged code, and HDOCS replayed the tutorials by hand against the workspace packages; nothing in CI replays them. | Default | Should each unit keep the tutorials in step, or should a tutorial replay run in CI (a third job)? |
| S1 | B19 | Opt in, not opt out | A capability support may hold must say `supportable: true`. An application's existing capabilities (a cost column, an approval) are no longer held by support until their module declares them. | Task (a missed capability must not leak again); plan rule (fail closed) | Is opting in the right default, or should only exits be marked? |
| S1 | B19 | Messaging customers | `backoffice.use` and `customers.message` stay supportable: a reply or a template sent while the grant lasts is audited and ends with it. | Default; B19 decision 10 (lasting access is the concern) | Should support never message a business's customers, even with consent? |
| S1 | B19 | Agents | Support can no longer make, run or pause agents (`agents.create` and `agents.manage`). Pausing a runaway agent is a fair support task. | Default (fail closed) | Should pausing be split from running into its own capability, so support could hold it? |
| S1 | B19 | Approvals | `approvals.decide` and `marketing.approve` are refused in a request now, instead of being held and never working. | B19 decision 11 | Is a 400 clearer for operators than the earlier silent no-op? |
| S1 | B19 | Links already made | Links made under support before this fix have no `on_behalf_of`. They keep working until they expire. | Plan migration rule (additive only) | Should the migration bind them (by `created_by`, the grant's window and tenant), or revoke them? |
| S1 | B19, B18 | Support and privacy | No privacy-specific support check: `privacy.manage` gates every step and is not supportable. | Task scenario 2 | Should the privacy feature also refuse support principals directly, as a second wall? |
| S1 | B19, B9 | Which links end with their maker | Only links made under a platform standing (`on_behalf_of` set) are bound to it. A member's record or form link survives the maker leaving, as B9 decided; a key no provider vouches for counts as ended. | B9 decision 15; default (fail closed) | Should a member's record and form links also stop when they leave the business, as page links do? |
| S2 | B10 | Identical bodies | For a sender whose ids are unsigned, two events with byte-identical bodies are one event. Senders usually put an id or a time in the body, so this should not happen. | Task note (a body-hash key in `InboundService.receive`); default (fail closed) | Is there a sender the product needs that sends identical bodies for distinct events and cannot sign its ids? |
| S2 | B10 | Bearer-token senders | Google Calendar's push notices prove themselves with a token only, so anyone who sees one can forge others. Its handler is naturally idempotent. | B17; default | Should a connector of that kind be limited to handlers that only read the sender again? |
| S2 | B10 | Senders that do not declare signed ids | `signedIds` is false unless declared; `hmacConnector` treats ids as signed only when the id is its own hash of the body. Ids read from the body need an explicit `signedIds: true`. | Default (fail closed) | Should a batch sender whose retries regroup events (a different body) be forced to declare its ids? Otherwise events of the first batch are stored again. |
| S3 | B6 | SLA list pages | The list answer changed from an array to `{ items, nextCursor }`. | Default | Should the Today view page further than its first `limit`, or is the first page always enough there? |
| S3 | B6 | Clocks of internal entities | Clocks of an `internal` entity are no longer shown to people either. | Default | Is there a case where people should see a clock on a record they cannot open? |
| S3 | B6 | Clocks without the state field | A reader who cannot see the state field sees none of the record's clocks, rather than clocks with the state blanked. | Default | Should such a reader see that a deadline was missed without the state it was missed in? |
| S3 | B6 | Short pages | A page can hold fewer than `limit` clocks when a projection hides some records' state. | Default | Acceptable for the Today view, which shows the first page only? |
| S4 | A3, A8 | Recall is refused at the pause like a turn | Recall is refused at the pause like a turn: it is a read, but also a paid model call. | Default | Should a paused business still recall (only the indexer stopped), or should recall be refused only by the budget and not by an `embedding_tokens` limit? |
| S4 | A3, A8 | Estimated embedding tokens | Embeddings estimated at four characters a token when the gateway reports nothing. | Default | Should the deployment be able to set the ratio, or refuse such a gateway? |
| S4 | A3, A8 | Embedding price | Embedding price defaults to the model's own price plus the markup. | Default | Should embeddings be free to businesses unless the operator prices them (`embedding_tokens`)? |
| S4 | A3, A8 | The indexer and a paused business (S4) | 5 seconds between checks of a paused business in the indexer. Indexing resumes at most that long (plus the 10 s settings cache in another process) after a top-up or the override is cleared. | Default | Is that fast enough? |
| H1, X1 | A5 | Outsiders never decide their own request | A principal with participant standing, or holding only the roles the framework gives contacts and participants (read through the business's roles), never decides their own request and cannot be a band's named approver; the holders of `approvals.decide` do. A member who holds only the contact's role counts as outside. | A5 decision 14; B7 (participants are never named approvers); X1 boundary fix | Should a membership alone ever make someone a decider of their own requests, whatever its roles? |
| X1 | A5 | An explicit requester rule | An application that writes `by: 'requester'` on a rule that participants can reach lets them approve their own assistant's request. | Default (the application's rule wins) | Should the framework send an outsider's request to the business even when the application's rule says `'requester'`? |
| X1 | A5 | Capability deciders and standing | A request decided by a capability (such as `approvals.decide`) may be decided by anyone holding it in the business. A business that gives its contact or participant role `approvals.decide` lets those outsiders decide other people's requests (support access is refused separately, `support_cannot_decide`). | Default; `support_cannot_decide` covers support access | Should only the team ever decide, whatever a business gives its outsider roles? |
| X2 | Boundary | An invalid stored zone | Ignored (the deployment's zone applies) rather than refused: an offset or an abbreviation too, so JS and SQL agree. | Default (JS and SQL must agree) | Should the back office warn a business whose stored zone is not a zone? |
| X2 | Boundary | Abbreviations and offsets | Refused everywhere (`IST`, `CET`, `GMT`, `+05:30`), and only `UTC` itself among the short names; a person picks an Area/Location name. | Default (Postgres reads `+05:30` and `IST` as other zones) | Should the settings screen offer a list of zones (and map a market's usual abbreviation to its zone) instead of free text? |
| X2 | Boundary | Changing a business's zone | Allowed at any time to `settings.manage`; numbers, credit periods and SLA clocks already started keep their periods, the next ones follow the new zone. | Default | Should a zone change mid-financial-year need an approval or be refused once numbers have been issued? |
| X2 | Boundary | A contact's zone | A new contact takes its business's zone; a person who links their number gives their device's. | Default | Should a contact's zone follow later changes to the business's zone? |
| HLANG | Boundary | Compile-time completeness | Dropped: a missing Hindi word compiles and reads as English; the sample's views test checks its view words. | Plan boundary rule (languages change with the business); default | Should an application be able to opt in to compile-time completeness for its own languages (a typed register of its languages), at the cost of a second declaration? |
| HLANG | Boundary | English's default locale | `en-GB` (day-month, 24-hour) for an application that does not set one. | Plan boundary rule; default | Is `en-GB` the right neutral default, or should English default to plain `en` (US order) and every application choose? |
| HLANG | Boundary | Keywords in undeclared languages | The framework's Hindi and Telugu STOP, HELP etc. match in every application. | Default (safer for consent) | Should an application that does not speak Hindi still honour a Hindi STOP (safer for consent), as now, or match only its own languages? |
| HLANG | Boundary | A language per business | The set is the application's; a business cannot narrow it or pick a default other than English. | Plan boundary rule; default | Should a business choose which of the application's languages it offers, and its own default? |
| HLANG | Boundary | Speech provider coverage | A declared language's speech tag is passed to the provider as is; nothing checks that the provider supports it. | Default | Should the voice worker refuse (or fall back to English for) a language its provider does not speak? |
| HDOCS | Docs | Section 14's scope | Only what is missing; status rows ("Hooks that run", "Plugin slots in use") left it. | Default | Is a list of what is wired where wanted somewhere (an architecture appendix), or is the code enough? |
| HDOCS | Docs | CLAUDE.md length | Kept every rule, shorter. | Default | Should CLAUDE.md shrink to commands and pointers only, leaving every rule to the developer guide? |
| HDOCS | Docs | `scripts/wt.sh` in the guides | Documented as the repository's helper for parallel worktrees. | Default | Is it part of the product (kept generic, with its base branch configurable), or tooling for this build only? |
| HCONS | B3 | A currency for the assistant's creates | A plain create of a record with money must name its currency. The assistant cannot see the business's currency, so the person must say it (the sample's briefs evals do). | B3B5 money plugin (CRUD creates do not take the business's currency); default | Should a create that names no currency take the business's currency (its `money` settings, then `DEFAULT_CURRENCY`), and refuse only when there is neither? Or should the assistant be told the business's currency in its instructions? |
| HCONS | Packaging | Dependency ranges | `better-auth` and its Expo plugin are exact pins, at the OAuth plugin's version. Everything else keeps its range. | Default | Should the `@hykr/*` packages pin more of their runtime (Mastra, the AI SDK, OpenTelemetry), or should the scaffolder write an `overrides` block, so a new application installs exactly what CI tested? |
| HCONS | Evals | Spoken cases per module | Every module with tools has English, Hindi and Telugu spoken cases. | Default | Should a module nobody uses by voice be allowed to have none, with `eval voice --module` skipping it? |
| REPORT | Report | The register is a snapshot | It reflects the decisions docs as merged at `10b54eae` (HCONS). A later change to a unit's doc does not update it. | Default | Should the register be regenerated by a script in CI instead of kept by hand? |
| REPORT | Report | Process notes are left out | Process notes are left out (decision 2). | Default (REPORT decision 2) | Should the owner also see them, for example the two hot-file deviations the integrator merged (A1 in `auth.ts`, A4 in `define-entity.ts`)? |

## Run report

### What merged

All 50 units merged into `feat/platform-gaps`, each as its own merge commit (listed in the
[index](#index)), in dependency order: the foundation (F0, then F6, F4, F3, F5, F1, F2), the gaps as
their dependencies landed, then the fix units. This unit, REPORT, merges after this page.

- **Not merged:** none. No unit was blocked, so no dependent was skipped.
- **Merged twice:** A3 and A5 merged a second time with follow-up work: A5 with its integration
  fixes (the sample's orders and live tests follow approval levels and the undo window, orders at
  the irreversible level), A3 with exact amounts in the reader's language and an integrations test
  that waits for the delivery to be marked delivered.
- **Migrations:** no unit committed a migration. The integrator generated the migrations of each
  unit that changed the schema at its merge (`framework/db/drizzle/0001_f3.sql` to `0029_x2.sql`,
  `application/domain/drizzle/0000_domain.sql` to `0008_b12.sql`), so journal times stay in order.
- **Hot files:** two units recorded editing a hot file they were not listed for, both merged: A1 in
  `auth.ts` and A4 in `define-entity.ts` (the register's first row).

### How it was checked

- Each unit built, typechecked, linted and ran its own tests in its worktree, with its own
  database; two reviewers then checked it (spec and PRD conformance, the boundary rule;
  correctness, tenancy, security and tests), and blocking findings went to a fix round.
- After each merge the integrator ran CI in the main checkout. The last run, at `10b54eae` (the
  HCONS merge, the branch's head before this unit), passed every step: install, lint, the
  boundary check, build, typecheck, lint:deps, migrate on an empty database, and the tests:
  framework e2e 71 files and 1,168 tests, application e2e 29 files and 178 tests (the golden
  WhatsApp conversations included, which skip in worktrees), the domain's 4 files, every unit
  suite, 36 of 36 turbo tasks.
- HCONS ran the same sequence in its worktree (`fa27cd2f`, passed, golden conversations skipped)
  and the consumer job with `--run`: the application scaffolded from the packed tarballs installed,
  migrated, started and passed the scripted-model evals (assistant 33 of 33, voice 39 of 39,
  WhatsApp 30 of 30). Every module's evals pass except `account`, which has nothing to evaluate.
- `scripts/check-boundary.sh` passes on the branch with this page (`wt.sh check REPORT`).

Not run by any unit or by the integrator's CI, so still to do (the plan's final verification):

- The `pnpm dev` smoke flows: orders from lines to an OTP acceptance of a frozen v1, a parked agent
  run that resumes, an MCP client's OAuth handshake, a credit cap pausing at 100%, and push falling
  back to WhatsApp and email in whaloc and Mailpit.
- `pnpm templates:sync`, native apps and Maestro, push to a real device, live models and live voice,
  and `npm create` from the registry.
- The new consumer steps on GitHub Actions (checked locally with `CI=true` and actionlint), and
  pushing the branch and opening the draft pull request (no unit may push).

### Known gaps still open

Per unit, what it reported as not done that is still not done after every merge. Items the
integration closed are left out (local migrations, "not merged with the latest base", "suites not
re-run": HCONS's full CI covers them). An item a later unit fixed says so. Developer guide section
14 ("Not ready yet") is the maintained list, with a workaround for each.

- **F0**
  - No known gaps were reported, and F1 to F6 built what its doc deferred.
- **F1**
  - No known gaps were reported; its doc's Deferred section lists what it left: a per-module tool filter for the assistant (still open: section 14 "Per-module tools for the assistant") and per-module Postgres schemas (all module tables stay in `app`).
- **F2**
  - No known gaps were reported; its doc's Deferred section lists what it left: a dependency-cruiser rule for app modules and a check of app modules against server modules (both still open: section 14 "Module boundaries in the app", "App modules without a server module").
- **F3**
  - No known gaps were reported; its doc's Deferred section lists what it left: tool descriptions for added list field types and plugin parks (still open, section 14).
- **F4**
  - No known gaps were reported; its doc's Deferred section lists what it left: checking at boot that every role an access map names is registered, and labelling system and support rows in history (section 14 "Support in history and events"). `actor.role` has since been removed.
- **F5**
  - No known gaps were reported; its doc's Deferred section lists what it left: deleting relayed rows of `app.domain_events` after a period (the table grows) and removing schedulers the code no longer declares (section 14 "Removing stale schedules"). A poison stored row no longer fails its batch: V6 marks it failed with its reason and relays the rest (section 14 "Seeing failed stored events").
- **F6**
  - No known gaps were reported; its doc's Deferred section lists what it left: recording SQL hook files by checksum, a Chromium document engine, and `notifications.e2e.test.ts` still reading Mailpit at `localhost:8025`.
- **A1**
  - The framework features' assistant tools (files, documents, jobs, memory, comments) and the platform commands are not offered over MCP; their routes declare no scope (an owner question in the register).
  - A decision on an approval an MCP client parked enqueues A7's resume job, which finds no suspended run: harmless, one extra job per decision.
- **A2**
  - Never run in a browser that ships WebMCP: the adapter is tested against fakes of the draft API shapes only.
  - WebMCP declarative actions are deferred: the API refuses every write on the `webmcp` channel.
  - The assistant's list and get tools build their own wording; WebMCP takes it from `entityReadTools`. The two are kept in step by hand.
  - Read-only commands (reports) have no WebMCP tool, and WebMCP calls are neither metered nor switched by a flag.
- **A3**
  - No payment gateway ships (as planned): a payment connector registers a `CreditPurchaseProvider` and calls `settlePurchase` from its verified webhook (H3 binds it to the connection's business).
  - One call, turn, voice session or message can still take a business past its cap (H3 now refuses an agent's next call once paused).
  - Still not metered: WhatsApp voice-note transcription and voice sessions whose worker never reported an end. The guardrail (H3) and embeddings (S4) are metered now.
  - The credits screen and the refusal messages were typechecked and built, not driven in a browser or on a device.
  - Fixed by B19: the shared operator key; B19 also added the cross-business usage report.
- **A4**
  - Invitations are not emailed: the inviter shares the code (section 14).
  - The back office has no business switcher (B7 added one to the app).
  - Fixed later: notification words per recipient (H1), deciders by capability (A5), PDFs, webhooks and summaries reading through `toRead` or `eventFor` (B2, B10, B14).
- **A5**
  - An operation-level `approval.by` still decides every park of that operation, level parks included; this is a documented rule (developer guide 5.8), not enforced.
  - The sample has no marketing template of its own; its test uses the framework's `monthly_update_v1`.
- **A6**
  - A resume that throws outside the paths that call `afterTurn` leaves the run `running` until `recover()` marks it failed after 15 minutes.
- **A7**
  - No known gaps were reported; its doc's Deferred section lists what it left: waits other than approvals (a question, a timer, a webhook), push for a continuation, WhatsApp buttons for a park a continuation makes, resuming a run refused by credits after a top-up, and cancelling a parked plan when the person starts something else (section 14 "Durable runs").
- **A8**
  - The pgvector distance path is written but untested: the compose and CI images have no vector extension, so recall runs on `app.memory_cosine`, with no approximate index.
  - A turn's recall cannot prefer memory of the record on screen; the recall API and tool take `about` instead.
  - No app or back-office screen edits business memory or the `memory` settings (the back office edits settings as JSON).
  - Automatic memory extraction from conversations is deferred.
  - Fixed by S4: embedding calls are metered.
- **A9B15**
  - There is no EAS project id or `eas.json`, so dev builds cannot get an Expo push token; push to a real device was not exercised.
  - Web push (VAPID) is not supported; browser users get the next channel.
  - Live deletions reach only streams already told about the record and the person who deleted it.
  - The back office still polls its inbox and conversations; there is no `Last-Event-ID` replay.
  - Fixed by H1: push text is projected for the recipient.
- **A10**
  - No app or back-office screen for the model policy; the endpoints work.
  - No fallback model or provider, speech outside the policy, no operator- or plan-set policy and no deployment-wide region lock.
  - Mastra Studio (development only) builds its own request context and could set the model and business directly.
  - Cached-input and per-request prices are not modelled; the development OpenRouter provider has no prices unless declared in `MODEL_PROVIDERS`.
- **A11**
  - The app rail's tagline is still the product's `app.tagline` (B9 made the brand mark the business's, and both sign-ins show a verified domain's brand).
  - The back office shows a business's logo and name, not its colours.
  - Other processes notice a verified or removed domain within 30 s.
- **A11X**
  - No known gaps were reported; its doc's Deferred section lists what it left: files' bytes in the archive, streaming or splitting a large export, framework export sources (members, grants, files' metadata), a notification when it is ready, audited downloads, archive retention, an assistant tool, and importing an archive back.
- **B1**
  - No thumbnails, resizing or EXIF stripping; WhatsApp voice-note audio is not kept (only the words).
  - A file belongs to one record field: no copying, moving or versions. No quotas, no malware scanning, no multipart uploads over 5 GiB.
  - Objects of a deleted business, and of rows deleted outside the write path, stay in the bucket.
  - A parked command's file ids are checked only when it runs.
  - The MinIO image in compose is still `:latest` (now `cgr.dev/chainguard/minio`).
  - A production S3 bucket needs a CORS rule for the app's origins (documented, not automated); the image-picker config plugin needs a dev-client rebuild.
- **B2**
  - No known gaps were reported; its doc's Deferred section lists what it left: images in documents, a Chromium engine, digital signatures and PDF/A, notifications that carry a document, a sweeper for sends left `sending`, following a WhatsApp send's later failure, more scripts, and document retention (all in section 14).
- **B3B5**
  - No line-level assistant tools: `save-order` takes the whole tree.
  - Bulk insert covers children only; there is no bulk update.
  - The mobile orders screens and `ApprovalPreview` were typechecked, not checked by eye.
  - Fixed later: tenant money settings are editable (H2); the orders policy was adapted to A5's levels at merge.
- **B6B4**
  - No known gaps were reported; its doc's Deferred section lists what it left: business-editable workflows, a per-field approval pin, half-day holidays and per-branch calendars, escalations that wait for a person (all in section 14), and a database CHECK on state columns (an application can add one in `sql/post`). S3 fixed the SLA list's scan.
- **B7**
  - No known gaps were reported; its doc's Deferred section lists what it left: agent tools for parties, a participant as a named approver, capabilities per participant role, a back-office Parties screen and switcher, parties shared across businesses, emailed party invitations, child rows from WhatsApp contacts (all in section 14).
- **B8**
  - No e-sign provider ships, there is no SMS channel, no withdrawal of an acceptance, no assistant tool for acceptances, and no `trust proxy` setting.
  - An email-only recipient of a share link cannot sign (B9 lets a link's WhatsApp contact sign).
  - Fixed by H5: the sample's accepted order has a state of its own (`accepted`).
- **B9**
  - No SSR, SEO or link previews: share pages are the single-page web app.
  - Links are not sent by WhatsApp or email, and the assistant has no tool to make one.
  - An email-only recipient cannot accept a PDF through a link.
  - WhatsApp replies carry no share links (`RenderTurn.pages` is still unfilled).
  - A share URL always uses `APP_URL`, not a business's verified domain.
  - Guests cannot comment or upload files, and a form asks no file field.
  - No links without an end date, and one recipient per link.
  - The rail's tagline is still the product's.
- **B10**
  - An inbound event whose job throws outside a handler on all three attempts stays `processing` (the sweep re-queues only `pending`).
  - A manual retry is not conditional on the delivery not being `sending`; a racing claim can send twice, and the receiver can drop the repeat by `webhook-id`.
  - The WhatsApp keyword e2e tests ("Stop offers", "delete my data") are timing-sensitive under load.
  - No integration screens, no delivery order, auto-pause or alerts, no single inbound URL per connector (section 14).
- **B11**
  - No known gaps were reported; its doc's Deferred section lists what it left: a generic start route and tool, notifying the person when a job finishes, stopping the 2 s poll under a live stream, job retention and an operations view, moving a result file onto a record, telling the service to stop on erasure, and metering outside compute.
- **B12**
  - A cached copy carrying an optimistic patch for a later queued write is overwritten by an earlier write's answer until that write syncs (`If-Match` stays correct).
  - AppShell's wiring of `createShellSession` is covered by typecheck only; the session logic is unit-tested without React.
- **B13B14**
  - No known gaps were reported; its doc's Deferred section lists what it left: `repo.where(p, q)` replacing the recording connection, distinct counts, percentiles and fiscal quarters, polygons and tracking, server geocoding, and erasing check-in locations (B18 now gives the mechanism).
- **B16**
  - No known gaps were reported; its doc's Deferred section lists what it left: attachments, reactions and threads, comments from WhatsApp contacts, a server-side anchor filter, an unread badge, and agents as mention targets.
- **B17**
  - A completion fails when the browser lands where the person is not signed in; the app's sign-in screen drops the code and state, so they start again.
  - One web and one native return address per deployment.
  - A code that leaks to the person who started the sign-in, before the consenting browser completes, could still be finished by them (a narrow window).
  - The `/calendar` screen's handling of code, state and error has no automated test (no component tests in `framework/app`).
- **B18**
  - A team filing that waits for approval names a provisional request id on the approval.
  - Until a business sets `grievanceContact`, the register and HELP show the deployment's `DEFAULT_GRIEVANCE_CONTACT` or say none is named (X2); nothing asks a new business for it.
  - Nothing trims `app.idempotency` replies by age; erasure and retention only redact them.
  - Not caused by B18: `models.e2e.test.ts` "an owner sets it through the write path" fails now and then (it orders audit rows by a timestamp the two rows share).
  - Seen once, not captured: two failures in a 4-suite run right after a rebuild; six later runs passed.
- **B19**
  - The platform e2e test's tenant search expects exactly one "Provisioned Platform" business; a run that fails between creating and renaming it breaks every later run on that database.
- **B20**
  - Per-row owners and imported `createdAt` dates (they need `define-entity.ts` to accept framework-set columns).
  - Child records are never imported on their own; no files inside rows; no Excel (`.xlsx`).
  - No assistant tool to start an import, and no single approval for a whole import.
  - No API to read or forget the key map; no import screen in the back office.
  - `basecamp import` needs a running worker and the `s3` or `fs` storage driver; large JSON files through the local drivers pass `JSON_BODY_LIMIT`.
- **H1**
  - An approval request decided in the app only never goes to WhatsApp (there is no template without buttons): push or email instead.
  - An approval's inbox item stays when the request is decided.
  - A team member whose request someone else decided is not told the outcome.
  - Nothing checks that a notification's recipient may read the record (only its words are projected).
  - Outbox rows of a second write in the same transaction are held with the first undoable write.
- **H2**
  - No form per section: the back office edits each settings section as JSON.
- **H3**
  - A turn that calls `recall-memory` twice is covered only at the API level (the scripted model calls it once per turn).
- **H4**
  - Approvals someone else's assistant left waiting that name the erased person's email or number keep it until decided or expired.
  - No retention targets for integration deliveries, attempts and inbound events, the call log or calendar invites.
  - Inbound payloads in a sender's own shape (names, numbers written another way) are not nulled; there is no connector-specific redactor hook.
  - The Google clean-up after erasure is wired but not run with real tokens; the after-commit mechanism is tested with a fixture contributor.
  - Acceptance evidence cannot be anonymised after a period (the table is append-only).
- **H5**
  - Supplier acknowledgement and dispatch have no state or event; only `order.fulfilled` is handled, and nothing answers the supplier's system.
  - The business types the supplier connection's shared secret; the server does not generate it.
- **H6**
  - No known gaps were reported, and its doc defers nothing of its brief.
- **S1**
  - Share links made under support before S1 have no `on_behalf_of` and last until they expire (binding or revoking them is an owner question).
  - The back office's support request form takes free-text capability names; there is no picker of supportable capabilities and no `supportable` field in `GET /api/members/roles`.
- **S2**
  - A sender whose signature header also carries the timestamp (`t=…,v1=…`) needs its own `defineConnector`.
  - There is no retention for inbound rows; one added later must keep the keys (section 14).
- **S3**
  - The probe walk is not capped: a reader who reaches more than 1,000 records of an entity but few of its timers in the asked status probes each of those timers once (about 2 ms per thousand).
  - Shared entities with a state machine are left out of `GET /api/sla` lists when the deployment has a platform business.
  - The reach query costs what the entity's own list costs for that reader (no index on the owner column).
- **S4**
  - Embedding calls that fail or are aborted are not charged: the provider reports no usage for them.
  - No per-person rate limit on `GET /api/memory/recall`; spending is bounded by the business's caps.
  - WhatsApp voice-note transcription is still unmetered (H3 metered the guardrail).
- **X1**
  - No known gaps were reported, and its doc defers nothing.
- **X2**
  - No e2e test reaches a zone Intl knows but Postgres does not (this Postgres knows every name Node does); both cases are unit-tested.
  - `setDefaultTimeZone` after start checks only the shape and that Intl and Postgres know the name; the offset comparison runs at start and in `PUT /api/settings/time-zone`.
  - A zone written in lower case straight to the database is used as is.
- **HLANG**
  - Live voice (Sarvam) is not exercised: `VOICE_MODE=fake`.
  - Document fonts exist only for Latin, Devanagari and Telugu.
- **HDOCS**
  - Fixit screenshots were removed, not retaken.
  - Nothing in CI replays the tutorials, so they can drift (section 14).
  - Fixed by HCONS: the create-basecamp comment and `application/package.json` now name the six sample modules.
- **HCONS**
  - The assistant cannot create a record that carries money unless the person names the currency (an owner question).
  - `basecamp eval --module account` fails all three suites by design (nothing to evaluate).
  - The new consumer steps in GitHub Actions were checked locally (`CI=true`, actionlint); the first pull-request run is their first run on GitHub.
  - A new application still resolves `@mastra/deployer` and `@opentelemetry/api` past their peers' ranges (warnings only; not pinned).
- **REPORT**
  - The register is a snapshot of the docs at `10b54eae`; it is not regenerated.
