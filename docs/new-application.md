# Build a new application on Basecamp

This tutorial builds a new product on the framework from scratch: **Fixit**, a small repair
business. A person books repairs, sees what is coming up, and records each repair as done.
An assistant can do all of that too, in the app, on WhatsApp or by voice. When the assistant
completes a repair, the person approves it first.

By the end you will have:

- one entity (`repair`) and one command (`complete-repair`), each declared once;
- REST routes, agent tools, approvals, history and audit, generated from those declarations;
- a WhatsApp reminder an hour before each repair;
- the assistant's views (how a repair list looks in the chat, on the canvas, in text and in speech);
- a mobile and web app with a Repairs screen and a repair screen;
- an end-to-end test and an assistant eval.

Every file below is the real file from a run of this tutorial against the framework: it builds
and typechecks, and the tests and evals of step 11 pass on it. The entity is called `repair`, not
`job`: the framework already serves long-running jobs at `/api/jobs` (developer guide 5.17), and
`defineServer` refuses a module that claims a framework route or table.

> This is the "new application" tutorial. To add a feature to the sample application in this
> repository instead, read [tutorial.md](tutorial.md). [DOMAIN.md](../DOMAIN.md) is the
> reference for what each layer must export.

## How an application fits the framework

The framework is the `@hykr/*` packages. Your application is a small pnpm workspace that
depends on them and never reaches inside them. It is made of modules, one folder each, so
several people can build different parts at once. You hand them to the framework in exactly two
places:

| Where | What you write | What the framework does with it |
|---|---|---|
| `api/src/server.ts` | `defineServer({ name, persona, help, languages, channel, modules, migrations, contributes })` | Serves the REST API, runs the write path (rules, approvals, audit), builds the assistant and its tools, sends notifications, runs the WhatsApp channel |
| `mobile/src/app/_layout.tsx` | `<AppShell app modules plugins catalog registry config />` | Renders the shell: sign-in, navigation, the assistant thread, approvals, the canvas, saved pages and voice. `modules` are your app modules (`defineAppModule`); `plugins` the framework features you use (`livePlugin()`, `pushPlugin()`, `webMcpPlugin()`, `sharePlugin()` and the others) |

Everything else in your application is one of these:

```
domain/            the domain package: your modules, and what gathers them
  src/modules/<name>/  one module (this guide builds `repairs`):
    contracts/         entity and command specs (Zod), moduleSpec    → @application/domain/modules/<name>/contracts
    db/schema.ts       Drizzle tables, named after the module
    server/            Nest module: defineEntity / defineCommand; public.ts for other modules
    views/             what tool results look like (defineView)        → @application/domain/modules/<name>/views
    notifications/     WhatsApp templates and reminders
    agent/             rules, scripted-model scripts, evals
    index.ts           defineModule: the module, server side
  src/modules/index.ts the list of modules, in dependency order        → @application/domain/modules
  src/contracts/       every module's specs, for the app               → @application/domain/contracts
  src/views/           every module's views, for the app               → @application/domain/views
  src/db/index.ts      the migrations (drizzle/, one journal)          → @application/domain/db
  src/languages.ts     the languages the product speaks                → @application/domain/languages
  src/server/          what no one module owns: access.ts (who reaches   → @application/domain/server
                       which rows), approval-levels.ts, privacy.ts, index.ts (contributions)
  sql/pre, sql/post    idempotent SQL run around the migrations (extensions, triggers, CHECKs)
api/               server.ts (defineServer), main.ts, worker.ts, e2e tests
mobile/            Expo app: <AppShell>, your app modules (src/modules/<name>/), thin routes in src/app/
back-office/       Expo web app for staff; usually unchanged
package.json       the "basecamp" block: where the server and apps are
```

A module's `contracts`, `views` and `notifications` are read by both the server and the app, so
they import nothing from the server side. A module reaches another only through its
`contracts/` or its `server/public.ts`, and only one it lists in `dependsOn`. `pnpm lint:deps`
in the Basecamp repository enforces both; it's worth keeping the same discipline in your own
application. `basecamp module add <name>` writes a new module, both halves, and registers it;
[Working on modules in parallel](modules.md) says how several people build modules at once.

## 0. Before you start

You need:

- Node 24 and pnpm 12 (`corepack enable`);
- Docker, for Postgres, Redis, Mailpit, the WhatsApp emulator and LiveKit.

No model key is needed: `MODEL_MODE=fake` runs the real assistant loop on a scripted model,
and that is what this tutorial uses.

## 1. Create the application

```bash
npm create @hykr/basecamp fixit        # or: pnpm create @hykr/basecamp fixit
cd fixit
pnpm install
cp .env.example .env                    # fill the secrets with `openssl rand -hex 32`;
                                        # set MODEL_MODE=fake and VOICE_MODE=fake
pnpm exec basecamp infra up             # Postgres, Redis, Mailpit, whaloc, LiveKit
```

> **Inside the Basecamp repository** you don't scaffold: `application/` is the application. Run
> the same steps against it, with `pnpm build`, `pnpm db:migrate` and `pnpm dev` at the root.

The scaffold starts as a copy of the sample application (the modules meetings, notes, to-dos,
orders, briefs and account). Build it
and run it once, so you know the pieces work before you change anything:

```bash
pnpm -r build
pnpm exec basecamp db migrate
pnpm exec basecamp dev                  # API :3000, app :8081, back office :8082, Studio :4000
```

Sign up at http://localhost:8081, then stop it (Ctrl-C).

## 2. Remove the sample modules

Delete the sample's modules, their screens and their tests. Everything you delete here is
application code; nothing in `node_modules/@hykr` changes.

```bash
rm -rf domain/src/modules/meetings domain/src/modules/notes domain/src/modules/todos \
       domain/src/modules/orders domain/src/modules/briefs \
       domain/src/modules/notifications.test.ts domain/src/views/views.test.ts domain/drizzle \
       domain/sql/post/orders-states.sql \
       mobile/src/modules/meetings mobile/src/modules/notes mobile/src/modules/todos \
       mobile/src/modules/orders mobile/src/modules/briefs mobile/src/home \
       mobile/src/app/meetings mobile/src/app/notes mobile/src/app/todos \
       mobile/src/app/orders mobile/src/app/briefs \
       api/test/domain api/test/whatsapp api/test/voice
```

Keep these, which you will edit:

- `domain/src/modules/index.ts`, `domain/src/contracts/index.ts`, `domain/src/views/index.ts`
  (the lists of modules: step 9)
- `domain/src/modules/account/`: a module with no records, which words what the framework tells
  a business's people (its credits alerts, the privacy team's notices). Reword it for your
  product.
- `domain/src/db/index.ts`
- `domain/src/server/access.ts`
- `domain/src/server/approval-levels.ts`, `domain/src/server/privacy.ts` and
  `domain/src/server/index.ts`: what each approval level means in your product and which writes
  reach it (developer guide 5.8.1), and your processors, request deadline and retention periods
  (developer guide 5.27)
- `domain/src/languages.ts` (the languages your product speaks: English, then your own; each
  with its name, locale, speech tag and letters, `defineLanguages` in `@hykr/i18n`. Drop Hindi and
  Telugu if you don't speak them: a word in a language you don't declare is refused at boot)
- `api/src/server.ts`
- `mobile/src/modules/index.ts` (the list of app modules), `mobile/src/catalog.ts`,
  `mobile/src/settings.ts` (step 10)
- `mobile/src/app/_layout.tsx`
- `mobile/src/app/pages/*`
- `mobile/src/app/approvals/*` (the approvals list and the `/approvals/<id>` link WhatsApp sends)
- `mobile/src/app/+not-found.tsx`

> **A shortcut:** `pnpm exec basecamp module add repairs` writes every file of a `repairs`
> module with one placeholder entity, and registers it. This guide writes each file by hand
> instead, so you see what each one is for.

## 3. Contracts: declare the entity and the command

The spec is the single declaration everything else is generated from. Write it once, in Zod.

`domain/src/modules/repairs/contracts/repair.ts`:

```ts
import { CreatedBy, commandSpec, entitySpec } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);
const at = z.iso.datetime({ offset: true });

export const RepairStatus = z.enum(['booked', 'in_progress', 'done']);
export type RepairStatus = z.infer<typeof RepairStatus>;

/** A repair, as the API returns it. */
export const Repair = z.object({
  id: z.string(),
  title,
  address: z.string(),
  scheduledFor: z.iso.datetime(),
  status: RepairStatus,
  summary: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type Repair = z.infer<typeof Repair>;

export const RepairSpec = entitySpec({
  name: 'repair',
  label: 'repair',
  description:
    'Repairs: what to fix, where, and when (ISO date-time). Status moves booked → in_progress → done; finish one with complete-repair.',
  schemas: {
    read: Repair,
    create: z.object({ title, address: z.string().min(1).max(300), scheduledFor: at }),
    update: z
      .object({
        title: title.optional(),
        address: z.string().min(1).max(300).optional(),
        scheduledFor: at.optional(),
        // 'done' and the summary are written by complete-repair only (a rule on the entity).
        status: RepairStatus.optional(),
        summary: z.string().min(1).max(1000).optional(),
      })
      .refine((v) => Object.values(v).some((x) => x !== undefined), 'Send a field to change'),
  },
  // What people call each field, in every language (approval cards, history, voice).
  fieldLabels: {
    title: { en: 'Repair', hi: 'काम', te: 'పని' },
    address: { en: 'Address', hi: 'पता', te: 'చిరునామా' },
    scheduledFor: { en: 'When', hi: 'कब', te: 'ఎప్పుడు' },
    status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి' },
  },
  list: {
    filterable: { status: 'enum', scheduledFor: 'date', title: 'text' },
    sortable: ['scheduledFor', 'createdAt'],
    defaultSort: [['scheduledFor', 'asc']],
    search: ['title', 'address'],
    pageSize: { default: 25, max: 100 },
  },
  // The assistant never deletes a repair without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'repair.list', item: 'repair.card' },
});

export const CompleteRepairSpec = commandSpec({
  name: 'repair.complete',
  description:
    'Finish a repair: record what was done in one or two sentences and mark it done. Done repairs cannot be reopened.',
  input: z.object({ repairId: z.uuid(), summary: z.string().min(1).max(1000) }),
  output: Repair,
  http: { method: 'POST', path: '/api/repairs/:repairId/complete' },
  tool: 'complete-repair',
  expose: 'all',
  approvalNote: 'When the assistant calls it, the person approves it first.',
  view: { name: 'repair.card', id: (input) => input.repairId },
  verb: { do: 'complete', did: 'completed' },
  touches: ['repair'],
});
```

What each part does:

- **`schemas`.** `read` is what the API returns. `create` and `update` are what it accepts. The
  same schemas validate REST bodies, become the assistant's tool parameters, and type the
  app's hooks.
- **`list`.** The list grammar: which fields can be filtered (`?status=booked`,
  `?scheduledFor[gte]=…`), sorted and searched (`?q=`), and the page sizes. The assistant's
  `list-repairs` tool gets the same grammar.
- **`approval`.** When a write waits for a person: here, an assistant's delete.
- **`fieldLabels`.** What approval cards and history call each field, in each of the
  application's languages (`domain/src/languages.ts`). English is required; a language left out
  reads in English.
- **`views`.** Which registered views show this entity's results (written in step 6).
- **`commandSpec`.** A named operation beyond plain create, update and delete. It gets a route
  (`POST /api/repairs/:repairId/complete`), a tool (`complete-repair`) and a verb for history
  ("completed").

`domain/src/modules/repairs/contracts/index.ts` turns the specs into the module's isomorphic half:

```ts
/** The repairs module's specs: read by the server, the views and the app. */
import { moduleSpec } from '@hykr/contracts';
import { CompleteRepairSpec, RepairSpec } from './repair.js';

export * from './repair.js';

export const repairsSpec = moduleSpec({
  name: 'repairs',
  // The modules it builds on: none yet.
  dependsOn: [],
  entities: { repairs: RepairSpec },
  commands: [CompleteRepairSpec],
});
```

Entities are keyed by plural (`repairs`). That plural is the route (`/api/repairs`), the query-cache
key, and the name your app uses (`useEntityList('repairs')`). `moduleSpec` stamps every spec with
the module's name (`RepairSpec.module` is `'repairs'`), and the module's name prefixes its tables.

## 4. The table and its migration

`domain/src/modules/repairs/db/schema.ts`:

```ts
/**
 * The repairs module's tables, named after it (repairs, or repairs_<x>). Each needs an id, a tenant and
 * an owner column (customerColumn() too, for records customers have), and
 * created_by/created_at/updated_at: the framework's scoping, provenance and list grammar rely on
 * them.
 */
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { index, text, timestamp } from 'drizzle-orm/pg-core';

export const repairs = app.table(
  'repairs',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    address: text('address').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['booked', 'in_progress', 'done'] })
      .notNull()
      .default('booked'),
    summary: text('summary'),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('repairs_owner_scheduled_idx').on(t.ownerId, t.scheduledFor),
    index('repairs_tenant_customer_idx').on(t.tenantId, t.customerId),
  ],
);
```

The framework's scoping, provenance and list grammar rely on these columns:

- `id`
- `tenantColumn()`
- an owner column
- `customerColumn()`, if customers have rows
- `createdBy`, `createdAt` and `updatedAt`

`app`, `id`, `tenantColumn`, `customerColumn` and `user` come from `@hykr/db`.

Generate the migration and apply it:

```bash
pnpm exec basecamp db generate --name repairs   # → domain/drizzle/0000_repairs.sql
pnpm exec basecamp db migrate                # the framework's migrations, then yours
```

The migration contains only your tables: `drizzle.config.ts` reads every module's
`db/schema.ts` into one journal. The framework's tables (users, businesses, approvals,
channels) ship with `@hykr/db` and run first; the two sets are recorded separately
(`drizzle.__framework_migrations` and `drizzle.__app_migrations`).

## 5. The server: the entity and the command

`defineEntity` binds the spec to the table and adds your business rules. Every REST call and
every assistant tool call goes through the same write path: validate, idempotency, load,
authorize, run or park for approval, and audit.

`domain/src/modules/repairs/server/repair.entity.ts`:

```ts
import { defineEntity, deny } from '@hykr/core';
import { BUSINESS_ACCESS } from '../../../server/access.js';
import { RepairSpec } from '../contracts/index.js';
import { repairs } from '../db/schema.js';

/** Repairs: CRUD from the spec, plus the business's rules. */
export const Repair = defineEntity(RepairSpec, {
  table: repairs,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
  rules: [
    // A done repair stays done.
    (_p, action, row) =>
      (action === 'update' || action === 'delete') && row?.status === 'done'
        ? deny('done_is_final', 'A done repair cannot change')
        : null,
    // Finishing writes a summary, so it goes through complete-repair, never a bare PATCH.
    (_p, action, _row, input, ctx) =>
      action === 'update' &&
      (input?.status === 'done' || input?.summary !== undefined) &&
      ctx.via !== 'repair.complete'
        ? deny(
            'use_complete_repair',
            'Finish a repair with complete-repair, so its summary is recorded',
          )
        : null,
  ],
});
```

> **Fields a command writes must be in the entity's `update` schema.** A command writes through
> `Repair.repo.update`, which validates the patch against the public update schema. So `status:
> 'done'` and `summary` are in `update`, and a rule allows them only `via` the command
> (`ctx.via === 'repair.complete'`). Leave them out and the command fails with a 500 when it runs.
> The sample's meetings do the same with `status: 'closed'`.

`domain/src/modules/repairs/server/complete-repair.command.ts`:

```ts
import { allow, defineCommand, deny, type NamedEvent, needsApproval } from '@hykr/core';
import { CompleteRepairSpec } from '../contracts/index.js';
import { Repair } from './repair.entity.js';

/** repair.completed: a NamedEvent, so a notification can follow it. */
export class RepairCompleted implements NamedEvent {
  readonly eventName = 'repair.completed';
  constructor(readonly row: unknown) {}
}

/** Finish a repair. The assistant may draft it; the person approves before it is written. */
export const CompleteRepair = defineCommand(CompleteRepairSpec, {
  resource: { type: 'repair', id: (input) => input.repairId },
  load: async (tx, p, input) => ({ repair: await Repair.repo.get(tx, p, input.repairId) }),
  authorize: (p, { repair }) => {
    if (repair.status === 'done') return deny('done_is_final', 'This repair is already done');
    if (p.actor.kind === 'agent') return needsApproval('agent_completes', 'Completing a repair');
    return allow('owner_completes');
  },
  summarize: (input, { repair }) => `Complete ${repair.title}: ${input.summary}`,
  run: async ({ tx, principal, input, loaded: { repair }, via }) => {
    const done = await Repair.repo.update(
      tx,
      principal,
      repair,
      { status: 'done', summary: input.summary },
      via,
    );
    return {
      value: done,
      touched: [{ type: 'repair', id: done.id, change: 'updated', before: repair, after: done }],
      events: [new RepairCompleted(done)],
    };
  },
});
```

A command declares five things:

- **`resource`:** what it acts on.
- **`load`:** what it reads, inside the transaction.
- **`authorize`:** who may run it. It returns allow, deny or `needsApproval`.
- **`summarize`:** what an approval card says.
- **`run`:** what it writes. It returns the value, the rows it touched (for audit) and its events.

`RepairCompleted` is a `NamedEvent`, so notifications can follow it (step 7 cancels the reminder
on it).

`domain/src/modules/repairs/server/repairs.module.ts`:

```ts
import { commandController, commandHandler, entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { CompleteRepair } from './complete-repair.command.js';
import { Repair } from './repair.entity.js';

@Module({
  controllers: [entityController(Repair), commandController(CompleteRepair)],
  providers: [...entityHandlers(Repair), commandHandler(CompleteRepair)],
})
export class RepairsModule {}
```

Another module that builds on repairs (an `invoices` module with `dependsOn: ['repairs']`) would use
only what `domain/src/modules/repairs/server/public.ts` exports, for example `export { Repair } from
'./repair.entity.js'`: the entity's repo runs the framework's checks inside the caller's
transaction.

`domain/src/server/access.ts` (kept from the scaffold) says who reaches which rows:

- the owner their own rows;
- admins and ops the whole business;
- a customer the rows that are theirs.

## 6. Views: what the assistant shows

A tool result doesn't carry markup. It carries a *view*: a name, props and a query. Each
channel renders the view its own way:

- the app draws a component;
- WhatsApp sends the view's `text`;
- a spoken turn says its `speak`.

Views are declared here, once, and bound to components in the app (step 9).

`domain/src/modules/repairs/views/repair.ts`:

```ts
import { pick, spokenWhen, whenText } from '@hykr/i18n';
import { action, defineView, spokenList, type ViewLabels } from '@hykr/ui-registry';
import { z } from 'zod';
import { Repair, RepairSpec } from '../contracts/index.js';

const labels = {
  title: { en: 'Repairs', hi: 'काम', te: 'పనులు' },
  empty: { en: 'No repairs.', hi: 'कोई काम नहीं।', te: 'పనులు ఏవీ లేవు.' },
  noun: { en: ['repair', 'repairs'], hi: ['काम', 'काम'], te: ['పని', 'పనులు'] },
} satisfies ViewLabels;

const open = action<Repair>({ screen: 'repair.detail', params: (j) => ({ id: j.id }) });

export const RepairListView = defineView({
  name: 'repair.list',
  description: 'A list of repairs with when and where. Use for any list of repairs.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Repair) }),
  source: { entity: RepairSpec, into: 'items' },
  actions: { open },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? p.items
          .map((j) => `• ${j.title}, ${whenText(j.scheduledFor, ctx.timeZone, ctx.lang)}`)
          .join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((j) => j.title),
      labels,
      ctx,
    ),
});

export const RepairCardView = defineView({
  name: 'repair.card',
  description: 'One repair: what, where, when and its status.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ id: z.string(), item: Repair }),
  source: { entity: RepairSpec, into: 'item', by: 'id' },
  actions: { open },
  labels: { noun: labels.noun },
  text: (p, ctx) =>
    `${p.item.title} (${p.item.status}), ${whenText(p.item.scheduledFor, ctx.timeZone, ctx.lang)}, ${p.item.address}`,
  speak: (p, ctx) => `${p.item.title}, ${spokenWhen(p.item.scheduledFor, ctx.timeZone, ctx.lang)}.`,
});
```

`domain/src/modules/repairs/views/screens.ts` declares a screen the assistant can open on the canvas
(`act('open', repair)` opens it):

```ts
import { defineScreen } from '@hykr/ui-registry';
import { z } from 'zod';

/** The repair's own screen, which the assistant can open on the canvas. */
export const RepairDetailScreen = defineScreen({
  name: 'repair.detail',
  title: 'repair',
  description: 'One repair in full: what, where and when, completing it, and its history.',
  params: z.object({ id: z.uuid() }),
});
```

`domain/src/modules/repairs/views/index.ts`:

```ts
/** The repairs module's views and screens: what the assistant may show for repairs. */
import type { ScreenDef, UiPart, ViewDef } from '@hykr/ui-registry';
import { RepairCardView, RepairListView } from './repair.js';
import { RepairDetailScreen } from './screens.js';

export * from './repair.js';
export * from './screens.js';

export const repairsViews: UiPart = {
  name: 'repairs',
  views: [RepairListView, RepairCardView] as unknown as readonly ViewDef[],
  screens: [RepairDetailScreen] as unknown as readonly ScreenDef[],
};
```

View and screen names are unique across modules: a second `repair.list` anywhere stops the server
from starting.

## 7. Notifications: a reminder before each repair

Outside a customer's 24-hour window, WhatsApp delivers only approved templates. So anything
your app sends on its own initiative is a template, declared in code:

- **`defineTemplate`:** the words, in every language.
- **`defineNotification`:** when the message goes, to whom, and over which channels.

`domain/src/modules/repairs/notifications/index.ts`:

```ts
/** The repairs module's templates and notifications: a reminder before each repair. */
import { pick, spokenWhen } from '@hykr/i18n';
import { defineNotification, defineTemplate, type Row } from '@hykr/notifications';
import { z } from 'zod';

export const RepairReminder = defineTemplate({
  name: 'repair_reminder_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(60), time: z.string().max(60) }),
  body: {
    en: 'Reminder: {{title}} at {{time}}.',
    hi: 'रिमाइंडर: {{title}} {{time}} पर है।',
    te: 'రిమైండర్: {{title}} {{time}}కి ఉంది.',
  },
  example: { title: 'Fix the kitchen tap', time: '10:00 am' },
});

type RepairRow = Row & {
  title: string;
  scheduledFor: string;
  status: string;
  ownerId: string;
  customerId: string | null;
};

const SOON = { en: 'is in an hour', hi: 'एक घंटे में है', te: 'ఒక గంటలో ఉంది' } as const;

/** An hour before a booked repair, to its customer and its owner. A reschedule moves it. */
export const RepairReminderNotification = defineNotification<RepairRow>({
  key: 'repair.reminder',
  topic: 'reminders',
  schedule: {
    on: ['repair.created', 'repair.updated'],
    at: (j) =>
      j.status === 'booked' ? new Date(new Date(j.scheduledFor).getTime() - 60 * 60_000) : null,
    cancelOn: ['repair.deleted', 'repair.completed'],
  },
  to: (j) => [...(j.customerId ? [{ customerId: j.customerId }] : []), { userId: j.ownerId }],
  channels: ['whatsapp', 'email'],
  whatsapp: {
    template: RepairReminder,
    params: (j, r) => ({ title: j.title, time: spokenWhen(j.scheduledFor, r.timeZone, r.lang) }),
  },
  email: {
    subject: (j) => `Reminder: ${j.title}`,
    body: (j, r) => `${j.title} ${pick(SOON, r.lang)}.`,
  },
  dedupe: (j) => `repair.reminder:${j.id}`,
});

export const repairsNotifications = {
  templates: [RepairReminder],
  notifications: [RepairReminderNotification],
};
```

The framework handles the rest: consent, quiet hours, the person's language, falling back to
email. `to` reads the repair as stored; the words (`params`, the email) read it as each recipient
may, so a field hidden from them is not there. The reminder is scheduled from the stored
`repair.created` and `repair.updated` events, once their write has committed.
`pnpm exec basecamp templates sync` registers the template with the provider (whaloc locally).

## 8. The assistant: persona, rules, scripts and evals

The assistant's tools come from your specs: `list-repairs`, `summarize-repairs`, `get-repair`,
`create-repair`, `update-repair`, `delete-repair` and `complete-repair`. What you add is who the
assistant is (once, for the whole application: step 9), each module's rules, and, for the
scripted model, how it answers.

`domain/src/modules/repairs/agent/index.ts`:

```ts
/** What the repairs module teaches the assistant beyond its tools: rules, scripts and evals. */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases } from './evals.js';
import { repairsScripts } from './scripts.js';

export const repairsAgent: AgentModule = {
  rules: [
    'When the user says a repair is finished, draft a complete-repair call with a one or two sentence summary of what was done, then tell them to approve it.',
    'Book repairs at the time the user gives; if they give none, ask for it.',
  ],
  scripts: repairsScripts,
  evalCases,
};
```

The scripted model (`MODEL_MODE=fake`) runs the real agent loop: real tools, real API calls,
real approvals. Only the "thinking" is a script. That makes tests and evals free and
deterministic. `domain/src/modules/repairs/agent/scripts.ts`:

```ts
/**
 * The scripted model's knowledge of repairs (MODEL_MODE=fake: tests, CI and demos without a key):
 *   repairs                      list-repairs
 *   book <title> at <address> tomorrow   create-repair (tomorrow at 10:00)
 *   finish <title>: <summary> list-repairs → complete-repair (waits for approval)
 */
import { call, defineScript, items, sameTitle, say, sayIn, written } from '@hykr/agents/script';

export const repairsScripts = [
  defineScript({
    name: 'list',
    match: (text) => (/^repairs\??$/i.test(text.trim()) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-repairs');
      if (!r) return [call('list-repairs', { status: { in: ['booked', 'in_progress'] } })];
      const repairs = items(r);
      return [say(repairs.length ? `${repairs.length} open repair(s).` : 'No open repairs.')];
    },
  }),
  defineScript({
    name: 'book',
    match: (text) => {
      const m = /^book (.+?) at (.+?) tomorrow$/i.exec(text.trim());
      return m ? { title: m[1], address: m[2] } : undefined;
    },
    step: ({ title, address }, turn) => {
      const r = turn.result('create-repair');
      if (r) return [say(written(r, (j: { title: string }) => `Booked "${j.title}".`, turn))];
      const when = new Date(Date.now() + 86_400_000);
      when.setUTCHours(10, 0, 0, 0);
      return [call('create-repair', { title, address, scheduledFor: when.toISOString() })];
    },
  }),
  defineScript({
    name: 'finish',
    match: (text) => {
      const m = /^finish (.+?):\s*(.+)$/i.exec(text.trim());
      return m ? { title: m[1], summary: m[2] } : undefined;
    },
    step: ({ title, summary }, turn) => {
      const done = turn.result('complete-repair');
      if (done) return [say(written(done, () => `Completed "${title}".`, turn))];
      const list = turn.result('list-repairs');
      if (!list) return [call('list-repairs', { q: title })];
      const repair = items(list).find((j) => sameTitle(j.title, title));
      if (!repair)
        return [
          sayIn(turn, {
            en: `No repair called "${title}".`,
            hi: `"${title}" नाम का कोई काम नहीं।`,
            te: `"${title}" అనే పని లేదు.`,
          }),
        ];
      return [call('complete-repair', { repairId: repair.id, summary })];
    },
  }),
];
```

`written(...)` words the outcome: what was done, or that it waits for approval.

The eval is one conversation per module, scored turn by turn: the right tools in order, none of
the forbidden ones, and the reply's words. `basecamp eval --module repairs` runs it with a fresh
user (and the module's `evalSetup`, when it has one). `domain/src/modules/repairs/agent/evals.ts`:

```ts
import type { EvalCase } from '@hykr/agents/script';

/** One conversation, in order: later turns rely on what earlier ones created. */
export const evalCases: EvalCase[] = [
  {
    why: 'books a repair',
    input: 'book Fix the kitchen tap at 12 MG Road tomorrow',
    expect: { must: ['create-repair'], replyIncludes: 'kitchen tap' },
  },
  {
    why: 'lists open repairs',
    input: 'repairs',
    expect: { must: ['list-repairs'], mustNot: ['create-repair', 'complete-repair'] },
  },
  {
    why: 'completing looks the repair up first, and waits for approval',
    input: 'finish Fix the kitchen tap: replaced the washer',
    expect: { must: ['list-repairs', 'complete-repair'], replyIncludes: 'approv' },
  },
];
```

## 9. The module and the server definition

`domain/src/modules/repairs/index.ts` bundles the module's layers, server side:

```ts
/** The repairs module: repairs, booked, reminded and completed. */
import { defineModule } from '@hykr/api';
import { repairsAgent } from './agent/index.js';
import { repairsSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { repairsNotifications } from './notifications/index.js';
import { RepairsModule } from './server/repairs.module.js';
import { repairsViews } from './views/index.js';

export const repairs = defineModule({
  ...repairsSpec,
  server: RepairsModule,
  views: repairsViews.views,
  screens: repairsViews.screens,
  templates: repairsNotifications.templates,
  notifications: repairsNotifications.notifications,
  agent: repairsAgent,
  tables,
});
```

Then list it, one line per module, in the three lists the scaffold kept, where the sample's
lines were. A module comes after the modules it depends on. In `domain/src/modules/index.ts`:

```ts
import { account } from './account/index.js';
import { repairs } from './repairs/index.js';

export const modules = [
  repairs,
  account,
  // basecamp module add: one line per module, above this one.
];
```

In `domain/src/contracts/index.ts` (and the same in `domain/src/views/index.ts`, with
`repairsViews` and `moduleViews`; `account` has no views):

```ts
import { accountSpec } from '../modules/account/contracts/index.js';
import { repairsSpec } from '../modules/repairs/contracts/index.js';

export * from '../modules/account/contracts/index.js';
export * from '../modules/repairs/contracts/index.js';

export const moduleSpecs = [
  repairsSpec,
  accountSpec,
  // basecamp module add: one line per module, above this one.
] as const;
```

`api/src/server.ts` is where the server meets your modules. It names the product, says who the
assistant is and which languages it speaks, and gives `channel.does`: the sentence the WhatsApp
welcome and HELP use for what the assistant does.

```ts
// Fixit, as the server runs it: its modules, who the assistant is, and the migrations.
// `basecamp dev` and `basecamp start` run the API and the worker from this file.

import { migrations } from '@application/domain/db';
import { languages } from '@application/domain/languages';
import { modules } from '@application/domain/modules';
import { contributions } from '@application/domain/server';
import { defineServer } from '@hykr/api';

export const server = defineServer({
  name: 'Fixit',
  persona:
    'You are the assistant of a small repair business. You help book repairs, find them, and record them as done.',
  help: 'I can book, list and complete repairs.',
  // The languages it speaks (domain/src/languages.ts); the app is given the same ones.
  languages,
  // On WhatsApp, in the welcome and in HELP.
  channel: {
    does: {
      en: 'I can book your repairs, tell you when they are, and record them as done.',
      hi: 'मैं आपके मरम्मत के काम बुक कर सकता हूँ, उनका समय बता सकता हूँ और उन्हें पूरा दर्ज कर सकता हूँ।',
      te: 'నేను మీ రిపేర్ పనులను బుక్ చేయగలను, వాటి సమయం చెప్పగలను, పూర్తయినట్లు నమోదు చేయగలను.',
    },
  },
  modules,
  migrations: [migrations],
  // Fixit's approval levels, and the level rules that are not one module's.
  contributes: contributions,
});
```

`defineServer` checks, before anything serves, that the modules fit together: no entity, route,
tool, view, template or table declared twice, nothing named that isn't there, and no module's
script taking another's eval turn. It lists every problem in one error.

## 10. The app

The framework ships the whole shell: sign-in, navigation, the assistant, approvals, the
canvas, saved pages and voice. Your app adds three things:

- **what it serves:** the catalog and registry, built from your domain;
- **its app modules:** one per module of your domain, each with its destinations, its view and
  screen components and its routes;
- **its own settings:** the product's name and the screens that belong to no single module.

`mobile/src/catalog.ts` builds the catalog and registry from your modules and types your
screens:

```ts
/** What Fixit's app serves: its entities, commands, views and screens, and the framework's. */
import { moduleSpecs } from '@application/domain/contracts';
import { moduleViews } from '@application/domain/views';
import { createCatalog } from '@hykr/contracts';
import { createUiRegistry } from '@hykr/ui-registry';

export const catalog = createCatalog(...moduleSpecs);
export const registry = createUiRegistry(...moduleViews);

// Types entity names and rows in this app's screens: useEntityList('repairs') is Repair[].
declare module '@hykr/app' {
  interface Register {
    catalog: typeof catalog;
  }
}
```

The `declare module` block makes `useEntityList('repairs')` return typed `Repair` rows, and a typo
like `useEntityList('jbos')` fail to compile.

`mobile/src/settings.ts` is the app's own part. Fixit has no home screen of its own, so `/`
sends the person to their repairs:

```ts
import type { AppSettings } from '@hykr/app';

export const settings: AppSettings = {
  title: 'Fixit',
  tagline: 'Repairs, with an assistant',
  home: { href: '/repairs', label: 'Go to your repairs' },
};
```

The repairs module, app side (`mobile/src/modules/repairs/index.tsx`). Its destinations live under
`/repairs`, `bind` binds a component to each view and screen (`bindView` checks the component's
props against the view's schema at compile time), and `hrefFor` says where a repair opens, so the
assistant's activity and other modules can link to it:

```tsx
import { RepairCardView, RepairDetailScreen, RepairListView } from '@application/domain/views';
import { defineAppModule } from '@hykr/app';
import { bindScreen, bindView } from '@hykr/ui-registry/react';
import { RepairDetail } from './screens/RepairDetail';
import { RepairCardComponent, RepairListComponent } from './views';

export { RepairStatus } from './RepairStatus';

export const repairs = defineAppModule({
  name: 'repairs',
  nav: [
    { href: '/repairs', label: 'Repairs', icon: 'tool', match: (p) => p.startsWith('/repairs') },
  ],
  suggestions: [
    { text: 'repairs', what: 'your open repairs' },
    { text: 'book Fix the kitchen tap at 12 MG Road tomorrow', what: 'books a repair' },
    { text: 'finish Fix the kitchen tap: replaced the washer', what: 'waits for approval' },
  ],
  bind: () => {
    bindView(RepairListView, RepairListComponent);
    bindView(RepairCardView, RepairCardComponent);
    bindScreen(RepairDetailScreen, ({ id }) => <RepairDetail id={id} embedded />);
  },
  hrefFor: { repair: (id) => `/repairs/${id}` },
  // Read tools a browser agent may call on these screens (WebMCP), by useScreenContext name:
  // list-repairs and get-repair, with the person's access. `webMcpPlugin()` in _layout.tsx offers them.
  webmcp: { repairs: { reads: ['repairs'] }, repair: { reads: ['repairs'] } },
});
```

List it in `mobile/src/modules/index.ts`, one line per module:

```ts
export { repairs } from './repairs';
```

The shell merges the modules when it starts and refuses any collision (two modules with one
name, one destination or record type claimed twice, a view bound twice). Icons are
[Feather](https://feathericons.com) names. Other modules import a module only through its
`index.tsx`.

`mobile/src/modules/repairs/views.tsx`. This is how `repair.list` and `repair.card` look in the
chat and on the canvas:

```tsx
import type { RepairCardView, RepairListView } from '@application/domain/views';
import { OpenRow, Rows, ViewCard, when } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import type { ViewProps } from '@hykr/ui-registry/react';
import { RepairStatus } from './RepairStatus';

/** How repair.list looks in the chat and on the canvas. */
export function RepairListComponent({
  title,
  items,
  act,
  words,
}: ViewProps<typeof RepairListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(j) => (
          <OpenRow label={`Open ${j.title}`} onPress={() => act('open', j)}>
            <Text className="font-semibold">{j.title}</Text>
            <Text variant="muted">
              {when(j.scheduledFor)} · {j.address}
            </Text>
          </OpenRow>
        )}
      </Rows>
    </ViewCard>
  );
}

/** How repair.card looks. */
export function RepairCardComponent({ item, act }: ViewProps<typeof RepairCardView>) {
  return (
    <ViewCard title={item.title}>
      <RepairStatus status={item.status} />
      <Text variant="muted">
        {when(item.scheduledFor)} · {item.address}
      </Text>
      <OpenRow label={`Open ${item.title}`} onPress={() => act('open', item)}>
        <Text className="font-semibold text-primary">Open the repair</Text>
      </OpenRow>
    </ViewCard>
  );
}
```

One status badge, used everywhere a repair's status shows
(`mobile/src/modules/repairs/RepairStatus.tsx`):

```tsx
import type { RepairStatus as Status } from '@application/domain/contracts';
import { Badge, Text } from '@hykr/app/ui';

const LOOK = {
  booked: { label: 'Booked', variant: 'info' },
  in_progress: { label: 'In progress', variant: 'warn' },
  done: { label: 'Done', variant: 'success' },
} as const;

/** A repair's status, the one way the app shows it. */
export function RepairStatus({ status }: { status: Status }) {
  const look = LOOK[status];
  return (
    <Badge variant={look.variant} className="self-start">
      <Text>{look.label}</Text>
    </Badge>
  );
}
```

The repair's screen. The route and the canvas both show it.
`mobile/src/modules/repairs/screens/RepairDetail.tsx`:

```tsx
import { CompleteRepairSpec } from '@application/domain/contracts';
import {
  Button,
  errorMessage,
  Field,
  History,
  Loading,
  ScreenTitle,
  SectionHeading,
  useCommand,
  useEntity,
  useScreenContext,
  when,
} from '@hykr/app';
import { Text } from '@hykr/app/ui';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { RepairStatus } from '../RepairStatus';

/** One repair: what, where, when; complete it; its history. The route and the canvas show it. */
export function RepairDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  // The assistant's context: "finish this one" on this screen names this repair.
  useScreenContext(embedded ? undefined : { screen: 'repair', record: { type: 'repair', id } });
  const repair = useEntity('repairs', id);
  const complete = useCommand(CompleteRepairSpec);
  const [summary, setSummary] = useState('');
  if (!repair.data) return <Loading error={repair.error} />;
  const j = repair.data;
  return (
    <ScrollView contentContainerClassName="gap-5 p-5">
      <ScreenTitle title={j.title} subtitle={`${when(j.scheduledFor)} · ${j.address}`} />
      <RepairStatus status={j.status} />
      {j.status === 'done' ? (
        <Text>{j.summary}</Text>
      ) : (
        <View className="gap-2">
          <SectionHeading>Complete the repair</SectionHeading>
          <Field
            label="What was done"
            value={summary}
            onChangeText={setSummary}
            placeholder="e.g. Replaced the washer"
          />
          <Button
            title="Mark as done"
            icon="check"
            busy={complete.isPending}
            disabled={!summary.trim()}
            onPress={() => complete.mutate({ repairId: j.id, summary: summary.trim() })}
          />
          {complete.error && <Text className="text-danger">{errorMessage(complete.error)}</Text>}
        </View>
      )}
      <SectionHeading>History</SectionHeading>
      <History type="repair" id={j.id} />
    </ScrollView>
  );
}
```

`useScreenContext` tells the assistant what the person is looking at, so "finish this one"
can name this repair. `useCommand(CompleteRepairSpec)` runs the command as the person. Because a
person is completing it, it runs at once; the same command from the assistant waits for approval.

The repairs list, `mobile/src/modules/repairs/screens/Repairs.tsx`:

```tsx
import {
  at,
  Button,
  DateField,
  EmptyState,
  errorMessage,
  Field,
  isValidDate,
  isValidTime,
  LoadError,
  OpenRow,
  ScreenTitle,
  TimeField,
  todayLocal,
  useEntityList,
  useEntityMutation,
  useScreenContext,
  when,
} from '@hykr/app';
import { Text } from '@hykr/app/ui';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { RepairStatus } from '../RepairStatus';

/** Book a repair: what, where, when. */
function BookRepair() {
  const { create } = useEntityMutation('repairs');
  const [title, setTitle] = useState('');
  const [address, setAddress] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [time, setTime] = useState('10:00');
  const valid = title.trim() && address.trim() && isValidDate(date) && isValidTime(time);
  return (
    <View className="gap-2 rounded-card border border-border bg-card p-4">
      <Field
        label="Repair"
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Fix the kitchen tap"
      />
      <Field
        label="Address"
        value={address}
        onChangeText={setAddress}
        placeholder="e.g. 12 MG Road"
      />
      <View className="flex-row flex-wrap items-end gap-3">
        <DateField label="Date" value={date} onChange={setDate} />
        <TimeField label="Time" value={time} onChange={setTime} />
        <Button
          title="Book"
          icon="plus"
          busy={create.isPending}
          disabled={!valid}
          onPress={async () => {
            await create.mutateAsync({
              title: title.trim(),
              address: address.trim(),
              scheduledFor: at(date, time),
            });
            setTitle('');
            setAddress('');
          }}
        />
      </View>
      {create.error && <Text className="text-danger">{errorMessage(create.error)}</Text>}
    </View>
  );
}

/** Open repairs, soonest first, and a form to book one. */
export function Repairs() {
  useScreenContext({ screen: 'repairs' });
  const list = useEntityList('repairs', {
    status: { in: ['booked', 'in_progress'] },
    sort: 'scheduledFor',
  });
  return (
    <FlatList
      contentContainerClassName="gap-3 p-5"
      data={list.items}
      keyExtractor={(j) => j.id}
      ListHeaderComponent={
        <View className="gap-4">
          <ScreenTitle title="Repairs" />
          <BookRepair />
        </View>
      }
      renderItem={({ item }) => (
        <OpenRow
          label={`Open ${item.title}`}
          onPress={() => router.navigate(`/repairs/${item.id}`)}
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="shrink font-semibold">{item.title}</Text>
            <RepairStatus status={item.status} />
          </View>
          <Text variant="muted">
            {when(item.scheduledFor)} · {item.address}
          </Text>
        </OpenRow>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="repairs" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text variant="muted">Loading…</Text>
        ) : (
          <EmptyState
            icon="tool"
            title="No open repairs"
            body="Book one above, or ask the assistant."
          />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
```

The module's route components, `mobile/src/modules/repairs/routes.tsx`:

```tsx
import { useLocalSearchParams } from 'expo-router';
import { RepairDetail } from './screens/RepairDetail';

export { Repairs as RepairsRoute } from './screens/Repairs';

/** /repairs/:id: the repair's screen (the canvas shows the same one, bound in index.tsx). */
export function RepairRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RepairDetail id={id} />;
}
```

Expo Router builds its routes from the files under `mobile/src/app/`, so each route is a file
there: one line that re-exports the module's component. A module's routes sit in its own folder,
`src/app/<module>/`:

```tsx
// mobile/src/app/repairs/index.tsx
export { RepairsRoute as default } from '@/modules/repairs/routes';
// mobile/src/app/repairs/[id].tsx
export { RepairRoute as default } from '@/modules/repairs/routes';
// mobile/src/app/index.tsx: the app's own home, here straight to the repairs
import { Redirect } from 'expo-router';
export default function Home() {
  return <Redirect href="/repairs" />;
}
```

The saved-pages screen suggests a page the assistant can compose from your views
(`mobile/src/app/pages/index.tsx`):

```tsx
import { PagesScreen } from '@hykr/app';

/** The framework's saved pages, suggesting a page the assistant can compose from Fixit's views. */
export default function Pages() {
  return <PagesScreen ask="show my repairs this week" />;
}
```

`_layout.tsx`, `pages/[id].tsx` and `+not-found.tsx` stay as the scaffold made them. They
render the framework's shell and screens: `_layout.tsx` passes `settings`, the modules barrel
(`import * as modules from '@/modules'`), `catalog`, `registry`, `config` (with the languages
from `domain/src/languages.ts`) and the framework features the sample uses, as plugins, to
`<AppShell>`: the business switcher, settings and branding, live updates, push, WebMCP read
tools, credits, calendars, the inbox, data export, MCP connections, agents, "Your data", share
links and offline capture. Remove the plugins you don't want; `+not-found.tsx` serves their
screens. The scaffold's `account` module words
the credits alerts and `.env.example`'s `CREDITS_CONFIG` sets the prices and the plan every
business starts on (developer guide, section 7.6): change both for your product, or remove
`CREDITS_CONFIG` to measure usage without caps. `.env.example` also gives every business that
sets none the sample's currency, time zone and privacy contact (`DEFAULT_CURRENCY=INR`,
`DEFAULT_TIME_ZONE=Asia/Kolkata`, `DEFAULT_GRIEVANCE_CONTACT`): set your market's, or leave them
unset for the framework's neutral ones (no currency, UTC, no contact). Rename the app in
`mobile/app.json` (`name`, `slug`, `scheme`, the iOS `bundleIdentifier` and the Android
`package`). If you change `scheme`, change it in `_layout.tsx` too.

## 11. Test it

An end-to-end test boots your compiled API against real Postgres and Redis, with the scripted
model. `@hykr/api/testing` gives you `boot`, a signed-in `Person`, and helpers for the
assistant and the database. `api/test/repairs.e2e.test.ts`:

```ts
// Fixit end to end: the compiled API on real Postgres and Redis, with the scripted model.
import { boot, Person, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Compiled, like the app runs: Nest's DI needs the decorator metadata tsc emits.
import { server as application } from '../dist/server.js';

const ana = new Person('Ana');
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

beforeAll(async () => {
  await boot(application);
  await ana.signUp();
});
afterAll(shutdown);

describe('repairs', () => {
  it('a person books a repair and lists it', async () => {
    const made = await ana.call('POST', '/api/repairs', {
      title: 'Fix the kitchen tap',
      address: '12 MG Road',
      scheduledFor: tomorrow(),
    });
    expect(made.status).toBe(201);
    expect(made.body.value).toMatchObject({ status: 'booked', createdBy: 'person' });
    const list = await ana.call('GET', '/api/repairs?status=booked');
    expect(list.body.items.map((j: { title: string }) => j.title)).toContain('Fix the kitchen tap');
  });

  it("the assistant's completion waits for the person's approval", async () => {
    await ana.chat('book Paint the gate at 4 Lake View tomorrow');
    const turn = await ana.chat('finish Paint the gate: two coats, done');
    expect(turn.body.reply).toMatch(/approv/i);
    const approvals = (await ana.call('GET', '/api/approvals')).body as {
      id: string;
      action: string;
    }[];
    const parked = approvals.find((a) => a.action === 'repair.complete');
    expect(parked).toBeDefined();
    const ok = await ana.call('POST', `/api/approvals/${parked?.id}/approve`);
    expect(ok.body.status).toBe('approved');
    const repairs = (await ana.call('GET', '/api/repairs?q=gate')).body.items;
    expect(repairs[0]).toMatchObject({ status: 'done', summary: 'two coats, done' });
  });

  it('a repair is finished with complete-repair, not a bare PATCH', async () => {
    const repair = (
      await ana.call('POST', '/api/repairs', {
        title: 'Fix the fence',
        address: '3 Park Lane',
        scheduledFor: tomorrow(),
      })
    ).body.value;
    const patch = await ana.call('PATCH', `/api/repairs/${repair.id}`, { status: 'done' });
    expect(patch.status).toBe(403);
    expect(patch.body.reason).toMatch(/complete-repair/);
  });

  it('the person completes a repair directly, and a done repair stays done', async () => {
    const repair = (
      await ana.call('POST', '/api/repairs', {
        title: 'Clear the drain',
        address: '9 Hill Street',
        scheduledFor: tomorrow(),
      })
    ).body.value;
    const done = await ana.call('POST', `/api/repairs/${repair.id}/complete`, {
      repairId: repair.id,
      summary: 'Cleared',
    });
    expect(done.body.status).toBe('done');
    const again = await ana.call('PATCH', `/api/repairs/${repair.id}`, { title: 'Changed' });
    expect(again.status).toBe(403);
  });
});
```

Build, migrate and run it:

```bash
pnpm -r build                            # domain first: the app and the tests read its dist/
pnpm exec basecamp db migrate
(cd api && pnpm test)                    # 4 tests
```

Then, with the API running (`pnpm exec basecamp start api` in another terminal):

```bash
pnpm exec basecamp eval                  # your three cases: 3/3
pnpm exec basecamp eval whatsapp         # the framework's WhatsApp cases: 2/2
```

## 12. Run it

```bash
pnpm exec basecamp dev
```

Open http://localhost:8081 and sign up:

- **Book a repair with the form.** It appears with a "Booked" badge.
- **Ask the assistant** `book Fix the kitchen tap at 12 MG Road tomorrow`. The repair appears on
  the Repairs screen without a reload: the assistant wrote through the API, and the app refreshed
  what it touched.
- **Ask** `repairs`. The answer is your `repair.list` component, inline in the chat.
- **Ask** `finish Fix the kitchen tap: replaced the washer`. It waits for your approval. Approve
  it in the card, and the repair's History shows who asked, who approved, and when.

You also have, without writing them:

- the repair's history and the approval cards;
- saved canvas pages built from your views;
- WhatsApp, where the reminder goes an hour before each repair and the assistant answers in the
  customer's language;
- voice mode;
- the back office at http://localhost:8082, where staff pick up WhatsApp conversations;
- Mastra Studio at http://localhost:4000, with every assistant run traced.

## Checklist for your own domain

For each module (`domain/src/modules/<name>/`, or `basecamp module add <name>`):

1. **Contracts** (`contracts/`): an `entitySpec` per entity, a `commandSpec` per named
   operation, and `moduleSpec` with entities keyed by plural and the modules it `dependsOn`.
2. **Table** (`db/schema.ts`), named after the module, with the framework's columns. Then
   `basecamp db generate --name …` and `basecamp db migrate`.
3. **Server** (`server/`): `defineEntity` with `access` and `rules`, `defineCommand`, and the
   module's Nest module. Fields a command writes go in the update schema, with a `via` rule.
   What other modules may use goes in `server/public.ts`.
4. **Views** (`views/`): `defineView` per entity's list and item (`text` and `speak` for
   channels without a screen), and `defineScreen` for anything `open` shows.
5. **Notifications** (`notifications/`): `defineTemplate` and `defineNotification`. Then
   `basecamp templates sync`.
6. **Assistant** (`agent/`): rules, scripts with verbs of the module's own, eval cases.
7. **Bundle** (`index.ts`): `defineModule`, and one line in `modules/index.ts`,
   `contracts/index.ts` and `views/index.ts`.
8. **App half** (`mobile/src/modules/<name>/`): `defineAppModule` (nav, suggestions, bind,
   hrefFor, webmcp), a component per view and screen, one-line routes in `src/app/<name>/`,
   and one line in `mobile/src/modules/index.ts`.

Then, once:

9. **`api/src/server.ts`**: `name`, `persona`, `help`, `languages` (from
   `domain/src/languages.ts`, which `mobile/src/app/_layout.tsx` passes to the app too), and
   `channel.does` in each language.
10. **App** (`mobile/src`): `settings.ts` (title, tagline, home, and the screens that combine
    modules) and `catalog.ts`. Rename `app.json`.
11. **Tests and evals**: an e2e test per rule that matters, and `basecamp eval` (`--module` for
    one).

## Things that will trip you up

- **The app and the tests read the domain's compiled output.** Until `domain` is built, the
  mobile app's typecheck reports every `@application/domain/*` import as missing. Run
  `pnpm -r build` (it builds in dependency order); `basecamp dev` keeps it compiled from then on.
- **Fields a command writes must be in the update schema.** See step 5. Without them the command
  fails with a bare 500 rather than a clear error.
- **A refused write answers 403 with the rule's message in `reason`,** for example "Finish a
  repair with complete-repair…". The rule's code (`use_complete_repair`) is in the audit row's
  `rule` column.
- **The scaffold starts from the sample modules,** so step 2 is a deletion. Do it before you
  start, not as you go, or the sample's types mix with yours.
- **A module's views need a cast** (`as unknown as readonly ViewDef[]`): each view is typed by
  its own props, and the list holds views of different shapes.
- **Two modules can't share a verb in the scripted model.** The first module's script that
  matches takes the turn, so `defineServer` refuses to start when one module's script would take
  another module's eval turn. Give each module verbs of its own ("book …", "invoice …").
- **The mobile app lists native modules it doesn't import itself** (LiveKit, WebRTC, speech,
  SQLite, secure store) and their plugins in `app.json`. The framework's voice and storage need
  them, and Expo needs native modules installed in the app. Keep them.
