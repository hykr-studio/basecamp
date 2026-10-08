# Basecamp tutorial: build a feature end to end (site visits)

In this tutorial you add **site visits** to the template:

1. A customer asks for a site visit on WhatsApp. The assistant records it.
2. Staff confirm it in the app with a time. That is a command, `visit.confirm`.
3. The customer gets a confirmation, and later a reminder an hour before the visit.
4. Cancelling a **confirmed** visit needs staff approval. Cancelling a visit that is still only requested happens at once.

Every step below comes from an implementation that was built and tested against this repository: it builds, its API tests and golden WhatsApp conversation pass, and the assistant's evals pass with the new cases. The snippets are trimmed, and every name in them is real. The sample domain on `main` does not include site visits; you add them as you go. When you finish, you will have touched one folder in each layer that [`DOMAIN.md`](../DOMAIN.md) lists. You will not have changed any framework code.

| Layer | What you add | File |
|---|---|---|
| Contracts | `VisitSpec`, `ConfirmVisitSpec`, `CancelVisitSpec` | `packages/contracts/src/domain/visit.ts` |
| Database | the `app.visits` table and migration `0014` | `packages/db/src/schema/domain.ts`, `packages/db/drizzle/0014_site_visits.sql` |
| API | `Visit` (`defineEntity`), `ConfirmVisit` and `CancelVisit` (`defineCommand`), `VisitsModule` | `apps/api/src/domain/visits/` |
| Views | `visit.list`, `visit.card` | `packages/ui-registry/src/domain/visit.ts` |
| Notifications | two templates, two notifications | `packages/notifications/src/domain/visits.ts` |
| Assistant | scripted-model turns, rules, eval cases | `packages/agents/src/domain/visits.ts`, `evals.ts`, `index.ts` |
| App | a Visits screen and the inline view components | `apps/mobile/src/app/(domain)/visits.tsx`, `apps/mobile/src/domain/views/visit.tsx` |
| Tests | API e2e test, view test, golden WhatsApp conversation | `apps/api/test/domain/visits.e2e.test.ts`, `packages/ui-registry/src/domain/visits.test.ts`, `apps/api/test/whatsapp/conversations/13-site-visit.yaml` |

---

## Before you start

You need the toolchain from the root `package.json`: pnpm 12 (`packageManager: pnpm@12.9.1`), Node 24 (`.nvmrc`) and Docker.

```bash
pnpm install
cp .env.example .env          # fill BETTER_AUTH_SECRET, AGENT_API_KEY, VOICE_AGENT_KEY, APPROVAL_SECRET
                              # with `openssl rand -hex 32`; set MODEL_MODE=fake to work without a model key
pnpm infra:up                 # docker compose up -d: postgres, redis, mailpit, whaloc, whaloc-test, livekit, ...
pnpm build
pnpm db:migrate
```

A few facts that matter throughout:

- **The API tests run the compiled app.** `apps/api/test/support.ts` imports `../dist/app.module.js`, because Vitest's esbuild emits no decorator metadata. Build before you test.
- **`MODEL_MODE=fake` runs a scripted model.** It has no network and costs nothing. The vitest config forces it on for tests, along with `WORKER_INLINE=1`, `THROTTLE=off` and a fresh `BULL_PREFIX`.
- **The framework reads each domain folder only through its `index`.** `pnpm lint:deps` enforces this with the rule `framework-reads-the-domain-through-its-index`. Each step below therefore ends with a one-line change to an `index.ts`.

---

## Step 1. Declare the entity and its commands (contracts)

Everything starts from a spec. The REST routes, list grammar, agent tools, typed client and app hooks are all derived from it. Specs live in `@app/contracts`, which may depend only on `zod` and `@app/i18n` (rule `contracts-stays-a-leaf`).

### The record and its schemas

```ts
// packages/contracts/src/domain/visit.ts
import { z } from 'zod';
import { CreatedBy, commandSpec, entitySpec } from '../framework/spec.js';

const title = z.string().min(1).max(200);
const address = z.string().min(1).max(300);
const at = z.iso.datetime({ offset: true });

export const VisitStatus = z.enum(['requested', 'confirmed', 'done', 'cancelled']);

export const Visit = z.object({
  id: z.string(),
  title,
  address,
  startsAt: z.iso.datetime().nullable(),
  status: VisitStatus,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

/** What a customer (or their assistant) sends: what the visit is for, and where. Staff set the time. */
export const CreateVisitInput = z.object({ title, address });

/**
 * `status` is here so the commands can set it through the repository (which parses every
 * patch with this schema); an entity rule refuses it on a plain PATCH.
 */
export const UpdateVisitInput = z
  .object({
    title: title.optional(),
    address: address.optional(),
    startsAt: at.optional(),
    status: VisitStatus.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Send at least one field to change');
```

> **Pitfall: a field your commands set must be in the update schema.** `repo.update()` in `packages/core/src/entity/define-entity.ts` calls `spec.schemas.update.parse(patch)` before it writes. Zod drops keys that are not in the schema. If you leave `status` out, `Visit.repo.update(..., { status: 'confirmed' })` succeeds and silently changes nothing. The sample `UpdateMeetingInput` includes `status` for the same reason. You protect the field with a rule in step 3.

### The entity spec

```ts
export const VisitSpec = entitySpec({
  name: 'visit',
  label: 'site visit',
  description:
    'Site visits a customer asked for: what it is for (title), the address, the time once staff confirm it (startsAt), and a status (requested → confirmed → done, or cancelled). Ask for one with create-visit; cancel one with cancel-visit.',
  schemas: { read: Visit, create: CreateVisitInput, update: UpdateVisitInput },
  fieldLabels: {
    title: { en: 'For', hi: 'किसलिए', te: 'దేనికోసం' },
    address: { en: 'Address', hi: 'पता', te: 'చిరునామా' },
    startsAt: { en: 'Time', hi: 'समय', te: 'సమయం' },
    // ...status, createdBy
  },
  list: {
    filterable: { status: 'enum', startsAt: 'date', title: 'text' },
    sortable: ['startsAt', 'createdAt'],
    defaultSort: [['createdAt', 'desc']],
    search: ['title', 'address'],
    pageSize: { default: 25, max: 100 },
    examples: {
      status: '{ "in": ["requested", "confirmed"] }',
      startsAt: '{ "gte": "2026-10-07T00:00:00Z" }',
      title: '{ "contains": "kitchen" }',
    },
  },
  // The assistant may ask for and read visits; changing or removing one is for people.
  expose: { list: 'all', get: 'all', create: 'all', update: 'human', delete: 'human' },
  views: { list: 'visit.list', item: 'visit.card' },
});
```

`entitySpec` fills in the rest. `plural` becomes `visits` and `pascal` becomes `Visit`. Any `expose` action you leave out defaults to `'all'`. `approval` defaults to `{}`.

| Field | What it does here |
|---|---|
| `label` | The word in messages, for example `No such site visit` on a 404. |
| `fieldLabels` | Names for each field on the approval preview, in every language. `Labels` is `{ en, hi, te }`, so a missing translation does not compile. |
| `description` | Opens the `list-visits` tool's description (the get and create tools get generic text such as "Get one site visit by id." and "Create a site visit."), and appears in OpenAPI. |
| `list` | The list grammar for both HTTP and the tools (see the table below). Every name must be a column. Nothing checks this at startup: the first request that filters or sorts on a misspelt field fails with `List config names "x", which is not a column` (a 500). |
| `expose` | `'all'` gives a route and an agent tool. `'human'` gives a route behind `HumanOnlyGuard` and no tool. `'internal'` gives neither. |
| `views` | The registered views (step 4) used to show tool results. |

The operators each field type accepts (`packages/contracts/src/framework/list.ts`):

| Type | Operators |
|---|---|
| `enum`, `id` | `eq`, `ne`, `in` |
| `boolean` | `eq`, `ne` |
| `text` | `eq`, `ne`, `in`, `contains` |
| `date`, `number` | `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte` |

### The commands

A command is an action with its own rules that does more than a single CRUD write. It gets one HTTP route. Path params come from the input, and the rest of the input is the body.

```ts
export const ConfirmVisitInput = z.object({ visitId: z.uuid(), startsAt: at });
export const CancelVisitInput = z.object({
  visitId: z.uuid(),
  reason: z.string().min(1).max(300).optional(),
});

/** Staff confirm a requested visit with its time. Not an agent tool: people do this in the app. */
export const ConfirmVisitSpec = commandSpec({
  name: 'visit.confirm',
  description: 'Confirm a requested site visit for a time. Staff only.',
  input: ConfirmVisitInput,
  output: Visit,
  http: { method: 'POST', path: '/api/visits/:visitId/confirm' },
  expose: 'human',
  view: { name: 'visit.card', id: (input) => input.visitId },
  verb: { do: 'confirm', did: 'confirmed' },
  touches: ['visit'],
});

export const CancelVisitSpec = commandSpec({
  name: 'visit.cancel',
  description:
    'Cancel a site visit. A requested visit is cancelled at once; a confirmed one waits for the team to approve it.',
  input: CancelVisitInput,
  output: Visit,
  http: { method: 'POST', path: '/api/visits/:visitId/cancel' },
  tool: 'cancel-visit',
  expose: 'all',
  approvalNote: 'Cancelling a confirmed visit waits for the team to approve it.',
  view: { name: 'visit.card', id: (input) => input.visitId },
  verb: { do: 'cancel', did: 'cancelled' },
  touches: ['visit'],
});
```

- **`tool`** names the agent tool. `visit.confirm` has none, so the assistant cannot confirm visits, and `expose: 'human'` keeps the route for people only. A command spec has no `'internal'` level: leaving out `tool` is how you keep a command off the agent.
- **`approvalNote`** is appended to the tool description, so the model knows the call may be parked.
- **`verb`** words approval buttons and history ("Approve cancel", "cancelled it").
- **`touches`** lists the entities the app refreshes after the command runs.

### Register the specs

```ts
// packages/contracts/src/domain/index.ts
import { CancelVisitSpec, ConfirmVisitSpec, VisitSpec } from './visit.js';
export * from './visit.js';

export const domain = defineDomain({
  name: 'Meetings',
  entities: { todos: TodoSpec, notes: NoteSpec, meetings: MeetingSpec, visits: VisitSpec },
  commands: [CloseMeetingSpec, RescheduleMeetingSpec, ConfirmVisitSpec, CancelVisitSpec],
});
```

The key must be the plural. `defineDomain` throws `Domain entity "visit" must be keyed by its plural (visits)` if it is not.

**What you get for free at this step.** `packages/contracts/src/catalog.ts` merges your specs into `entities` and `commands`. Several things are derived from those lists:

- the agent's tools (`list-visits`, `get-visit`, `create-visit`, `cancel-visit`)
- the history resource types
- the app's `useEntityList('visits', …)`

None of it works until the API serves the routes (step 3).

---

## Step 2. The table and its migration (database)

Add the table to `packages/db/src/schema/domain.ts`, next to the sample tables:

```ts
/** Site visits a customer asked for; staff confirm them with a time. */
export const visits = app.table(
  'visits',
  {
    id: id(),
    tenantId: tenantColumn(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    customerId: customerColumn(),
    title: text('title').notNull(),
    address: text('address').notNull(),
    /** Null until staff confirm the visit with a time. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    status: text('status', { enum: ['requested', 'confirmed', 'done', 'cancelled'] })
      .notNull()
      .default('requested'),
    createdBy: text('created_by', { enum: ['person', 'assistant'] })
      .notNull()
      .default('person'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('visits_tenant_status_idx').on(table.tenantId, table.status),
    index('visits_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
);
```

The framework depends on these columns:

| Column | Why |
|---|---|
| `id`, `tenantId` | `defineEntity` looks them up by these exact JS keys. Without them it throws `visit: table needs id, tenantId and owner columns`. `id()` defaults to `gen_random_uuid()::text`. The generated `:id` routes use `ParseUUIDPipe`, so ids must be UUIDs. |
| `ownerId` | The `'own'` grant. For a customer's record, it is set to the business's `default_owner_id`. |
| `customerId` | The `'customer'` grant. `customerColumn()` uses `on delete set null`. |
| `createdBy` | Optional. When present, the framework sets it to `'assistant'` or `'person'`. |
| `startsAt` (nullable) | Sorting a nullable timestamp works, because nulls sort last. Sorting a nullable column of another type throws `Sorting on nullable ... is not supported`. |

Generate the migration. `drizzle-kit generate` diffs the snapshots and needs no database.

```bash
pnpm --filter @app/db generate --name site_visits
#   visits 11 columns 2 indexes 3 fks
#   [✓] Your SQL migration file ➜ drizzle/0014_site_visits.sql 🚀
pnpm db:migrate
```

The generated file is a plain `CREATE TABLE "app"."visits"` with three foreign keys and two indexes. Commit it together with `drizzle/meta/0014_snapshot.json` and the updated `_journal.json`.

> **Pitfall: shared databases and drizzle's bookkeeping.** `drizzle-kit migrate` records each applied migration with its timestamp. If several branches (or agents) each generate a `0014_…` and apply them to one database, the later merge can skip or collide. On a shared dev database, apply your migration from your own branch only. Expect to regenerate after you rebase onto someone else's migration.

---

## Step 3. The entity and the commands (API)

### The entity: table, owner, customer, access, rules

```ts
// apps/api/src/domain/visits/visit.entity.ts
import { VisitSpec } from '@app/contracts';
import { defineEntity, deny } from '@app/core';
import { visits } from '@app/db';
import type { Access } from '@app/policy';

/**
 * Visits are the business's, not one person's: everyone on the team reaches every visit, a
 * customer only their own (made by them on WhatsApp, or for them).
 */
export const VISIT_ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'tenant', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'tenant', customer: 'customer' },
};

/** The commands that may move a visit's status. */
const STATUS_COMMANDS = ['visit.confirm', 'visit.cancel'];

export const Visit = defineEntity(VisitSpec, {
  table: visits,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: VISIT_ACCESS,
  rules: [
    // A visit is confirmed or cancelled only by its commands, never by a bare PATCH.
    (_p, action, _row, input, ctx) =>
      action === 'update' && input?.status !== undefined && !STATUS_COMMANDS.includes(ctx.via)
        ? deny('use_visit_commands', 'Confirm or cancel a visit with its commands')
        : null,
  ],
  summarize: (action, input, row) => {
    const title = String(input?.title ?? row?.title ?? 'site visit');
    return action === 'create'
      ? `Ask for a site visit: ${title}`
      : `${action === 'update' ? 'Change' : 'Delete'} the site visit "${title}"`;
  },
});
```

**Why not `BUSINESS_ACCESS`?** The sample `apps/api/src/domain/access.ts` gives `staff: 'own'`. A customer's visit is owned by the business's default owner, so a staff member with `'own'` would never see the visits they need to confirm. Visits belong to the whole team, so every team role gets `'tenant'`. A `Grant` is one of three values (`packages/policy/src/access.ts`):

| Grant | Rows it reaches |
|---|---|
| `'own'` | Rows where the owner column equals the person's user id. |
| `'customer'` | Rows where the customer column equals `p.customerId`. |
| `'tenant'` | Every row in the business. |

Any id outside your grants is a **404, never a 403**.

**Rules and `ctx.via`.** Rules run in two places:

- inside `decide()` for CRUD calls, where `via` is `'crud'`
- inside `repo.insert/update/delete`, where `via` is whatever the caller passed

A command passes `via` (`{ via: 'visit.confirm' }`), so the rule can tell a command from a plain `PATCH`. This is the same pattern as the meeting rule `use_close_meeting`.

> **Pitfall: an entity rule cannot park a write.** `checkRules()` and `decide()` act only on `decision === 'deny'`. If a rule returns `needsApproval(...)`, nothing happens. For an entity's CRUD actions, approval comes only from `spec.approval[action]`. For anything conditional on the row, such as "only when confirmed", use a command whose `authorize` returns `needsApproval`.

### The commands: load, authorize, summarize, run

```ts
// apps/api/src/domain/visits/visit.commands.ts
import { CancelVisitSpec, ConfirmVisitSpec, type Principal } from '@app/contracts';
import { allow, defineCommand, deny, type NamedEvent, needsApproval } from '@app/core';
import { Visit } from './visit.entity.js';

const STAFF = ['owner', 'admin', 'ops', 'staff'];
/** Someone on the business's team (not only a customer of it). */
const isStaff = (p: Principal) => (p.roles ?? []).some((r) => STAFF.includes(r));

/** visit.confirmed: notifications send the confirmation and schedule the reminder on it. */
export class VisitConfirmed implements NamedEvent {
  readonly eventName = 'visit.confirmed';
  constructor(readonly row: unknown) {}
}

/** visit.cancelled: the reminder is cancelled on it. */
export class VisitCancelled implements NamedEvent {
  readonly eventName = 'visit.cancelled';
  constructor(readonly row: unknown) {}
}

export const ConfirmVisit = defineCommand(ConfirmVisitSpec, {
  resource: { type: 'visit', id: (input) => input.visitId },
  load: (tx, p, input) => Visit.repo.get(tx, p, input.visitId), // scoped: 404 if not theirs
  authorize: (p, visit, input) => {
    if (!isStaff(p)) return deny('staff_only', 'Only the team can confirm a visit');
    if (visit.status !== 'requested')
      return deny('not_requested', `This visit is ${visit.status}, not waiting to be confirmed`);
    if (new Date(input.startsAt).getTime() <= Date.now())
      return deny('in_the_past', 'Pick a time in the future');
    return allow('staff_confirms');
  },
  summarize: (input, visit) => `Confirm the site visit "${visit.title}" for ${input.startsAt}`,
  run: async ({ tx, principal, input, loaded: visit, via }) => {
    const confirmed = await Visit.repo.update(
      tx, principal, visit, { status: 'confirmed', startsAt: input.startsAt }, via,
    );
    return {
      value: confirmed,
      touched: [{ type: 'visit', id: visit.id, change: 'updated', before: visit, after: confirmed }],
      events: [new VisitConfirmed(confirmed)],
    };
  },
});

export const CancelVisit = defineCommand(CancelVisitSpec, {
  resource: { type: 'visit', id: (input) => input.visitId },
  load: (tx, p, input) => Visit.repo.get(tx, p, input.visitId),
  authorize: (p, visit) => {
    if (visit.status === 'cancelled' || visit.status === 'done')
      return deny('already_final', `This visit is already ${visit.status}`);
    if (visit.status === 'requested')
      return allow('not_confirmed_yet', 'Nobody is booked yet: it goes at once');
    if (isStaff(p) && p.actor.kind === 'user')
      return allow('staff_cancels', 'The team cancels its own visit');
    return needsApproval(
      'confirmed_visit_cancel',
      'This visit is confirmed: the team must approve cancelling it',
    );
  },
  // Who decides when it is parked: the team, never the requester themselves.
  approval: { by: ['owner', 'admin', 'ops', 'staff'] },
  summarize: (_input, visit) => `Cancel the site visit "${visit.title}" at ${visit.address}`,
  run: async ({ tx, principal, loaded: visit, via }) => {
    const cancelled = await Visit.repo.update(tx, principal, visit, { status: 'cancelled' }, via);
    return {
      value: cancelled,
      touched: [{ type: 'visit', id: visit.id, change: 'updated', before: visit, after: cancelled }],
      events: [new VisitCancelled(cancelled)],
    };
  },
});
```

Every command write goes through `runWrite` in `packages/core/src/write/pipeline.ts`, in this order:

1. **Validate.** The input is parsed again with the full `spec.input`.
2. **Idempotency.** An `idempotency-key` header is honoured.
3. **Load and authorize.** `load` and `authorize` run inside one transaction.
4. **Deny.** The transaction rolls back. An `outcome: 'denied'` audit row is written and the caller gets `403 { error: 'forbidden', rule, reason }`.
5. **Needs approval.** An `app.approvals` row is written, with an audit row with `outcome: 'needs_approval'`. The caller gets `{ status: 'needs_approval', approval }`.
6. **Allow.** `run` executes. There is one audit row per `touched` entry, plus one for the command. The caller gets `{ status: 'done', value }`.
7. **Events.** They are published only **after commit**.

Who decides a parked cancel? For a command, `approval` is an `ApproverRule` (`{ by, channels, minAssurance }`). It says **who** decides. Whether the command parks at all is decided only by `authorize`. Without `by`, `decidersFor` in `packages/core/src/write/approvals.ts` behaves like this:

| Requester | Who decides by default |
|---|---|
| A person with a user id who is not customer-only | The requester (they approve their own assistant's request). |
| A customer | `['owner', 'ops']` |

Setting `by` sends every parked cancel to the team, including a staff member's own assistant's request.

When the team approves, `ApprovalService.decide` replays the stored op in one transaction:

- The replay runs as the original requester, re-resolved with `resolver.refresh` and given `approvedBy: <decider>`.
- `authorize`'s `needs_approval` then becomes `allow` with rule `approved:confirmed_visit_cancel`.

> **Pitfall: entity events are not published for repo calls inside a command.** `visit.created/updated/deleted` come from the CRUD handlers (`entityOp` in `packages/core/src/entity/handlers.ts`). When your command calls `Visit.repo.update(...)`, nothing named `visit.updated` is published. If notifications should react to a command, publish your own `NamedEvent` (`eventName` and `row`), as `VisitConfirmed` does above.

### Wire the Nest module

```ts
// apps/api/src/domain/visits/visits.module.ts
@Module({
  controllers: [
    entityController(Visit),
    commandController(ConfirmVisit),
    commandController(CancelVisit),
  ],
  providers: [...entityHandlers(Visit), commandHandler(ConfirmVisit), commandHandler(CancelVisit)],
})
export class VisitsModule {}

// apps/api/src/domain/index.ts
@Module({ imports: [TodosModule, NotesModule, MeetingsModule, VisitsModule] })
export class DomainModule {}
```

Build and typecheck the API and everything it depends on:

```bash
pnpm turbo run build typecheck --filter=@app/api...
#  Tasks:    22 successful, 22 total
```

**What you get for free at this step:**

| Route | Who | Notes |
|---|---|---|
| `GET /api/visits` | people and the assistant | List grammar: `?status=requested&q=tiles&sort=-createdAt`, `startsAt[gte]=…`, `cursor`, `count=true`. Unknown fields give a 400. |
| `GET /api/visits/:id` | people and the assistant | 404 when it is not yours. |
| `POST /api/visits` | people and the assistant | `201 { status: 'done', value }`. A customer's visit is owned by the default owner and carries their `customerId`. |
| `PATCH /api/visits/:id`, `DELETE /api/visits/:id` | people only (`'human'`) | The assistant gets 403 "Only people can do this". |
| `POST /api/visits/:visitId/confirm` | people only | Body `{ startsAt }`. |
| `POST /api/visits/:visitId/cancel` | people and the assistant | Body `{ reason? }`. |

The build also gives you:

- agent tools `list-visits`, `get-visit`, `create-visit` and `cancel-visit`
- audit rows for every write
- history at `GET /api/history?resourceType=visit&resourceId=<id>`
- approval replay after restarts (`commandHandler` registers the op by name)

### Try it with curl

Start the API with `pnpm dev`, which runs the API and the worker. After a build you can instead run `pnpm --filter @app/api start` and `pnpm --filter @app/api start:worker`. The worker runs the queue processors that send WhatsApp messages and notifications: the API process registers `ChannelsModule.forRoot({ processors: config.workerInline })`, so with `start` alone the curl calls below work but nothing consumes the queues. Then:

```bash
API=http://localhost:3000
# A browser-like call that keeps the session cookie in ./jar (works in bash and zsh).
api() { curl -s -b jar -c jar -H 'origin: http://localhost:8081' -H 'content-type: application/json' "$@"; }

api $API/api/auth/sign-up/email \
  -d '{"name":"Owner","email":"owner@example.com","password":"password123"}' > /dev/null

api $API/api/visits -d '{"title":"Kitchen tiles","address":"12 Road No. 3, Banjara Hills"}'
# {"status":"done","value":{"id":"cc541543-…","title":"Kitchen tiles","address":"12 Road No. 3, Banjara Hills",
#  "startsAt":null,"status":"requested","createdBy":"person","createdAt":"2026-10-08T07:15:39.979Z"}}
ID=cc541543-…   # the id from that response

api -X PATCH $API/api/visits/$ID -d '{"status":"confirmed"}'
# {"error":"forbidden","rule":"use_visit_commands","reason":"Confirm or cancel a visit with its commands"}

api $API/api/visits/$ID/confirm -d '{"startsAt":"2026-10-09T07:15:40.069Z"}'
# {"status":"done","value":{…,"startsAt":"2026-10-09T07:15:40.069Z","status":"confirmed",…}}

api "$API/api/history?resourceType=visit&resourceId=$ID"
# [{"action":"visit.create","outcome":"committed",…},
#  {"action":"visit.update","outcome":"denied","reason":"Confirm or cancel a visit with its commands",…},
#  {"action":"visit.update","outcome":"committed","reason":"staff_confirms",…},
#  {"action":"visit.confirm","outcome":"committed","reason":"staff_confirms",…}]
```

The history endpoint orders only by `at`, and every row written in one transaction gets the same `at` (the transaction time). So the last two rows, `visit.update` and `visit.confirm`, may come back in either order.

Sign-up and sign-in need an `origin` header from `WEB_ORIGINS`, because Better Auth rejects browser-like requests without one. The owner who signs up gets a business of their own with the role `owner`.

---

## Step 4. Views: how a visit is shown, written and spoken

A view is declared once in `packages/ui-registry`. The registry may import only contracts and i18n (rule `ui-registry-no-runtime`). Each surface uses a different part of it:

| Surface | What it uses |
|---|---|
| The app | The view's name. You bind a component to it (step 7). |
| WhatsApp | `text(props, ctx)` |
| Voice | `speak(props, ctx)` |

```ts
// packages/ui-registry/src/domain/visit.ts
import { Visit, VisitSpec } from '@app/contracts';
import { type Labels, pick, spokenWhen, whenText } from '@app/i18n';
import { z } from 'zod';
import { action, defineView, spokenList, type TextContext, type ViewLabels } from '../define-view.js';

const STATUS: Record<Visit['status'], Labels> = {
  requested: { en: 'waiting for a time', hi: 'समय तय होना बाकी', te: 'సమయం ఇంకా ఖరారు కాలేదు' },
  confirmed: { en: 'confirmed', hi: 'पक्का', te: 'ఖరారైంది' },
  // done, cancelled …
};
const noun = {
  en: ['site visit', 'site visits'],
  hi: ['साइट विज़िट', 'साइट विज़िट'],
  te: ['సైట్ విజిట్', 'సైట్ విజిట్‌లు'],
} as const;
const labels = {
  title: { en: 'Site visits', hi: 'साइट विज़िट', te: 'సైట్ విజిట్‌లు' },
  empty: { en: 'No site visits.', hi: 'कोई साइट विज़िट नहीं।', te: 'సైట్ విజిట్‌లు ఏవీ లేవు.' },
  noun,
} satisfies ViewLabels;

const when = (v: Visit, ctx: TextContext) =>
  v.startsAt && v.status === 'confirmed'
    ? whenText(v.startsAt, ctx.timeZone, ctx.lang)
    : pick(STATUS[v.status], ctx.lang);
const line = (v: Visit, ctx: TextContext) => `• ${v.title}, ${v.address} (${when(v, ctx)})`;

/** In the app: cancel from the card (a confirmed visit asks the team first). */
const cancel = action<Visit>({ command: 'visit.cancel', args: (v) => ({ visitId: v.id }) });

export const VisitListView = defineView({
  name: 'visit.list',
  description:
    'A list of site visits with their address, time and status. Use for "my visits" or the visits waiting to be confirmed. Not for one visit (visit.card).',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Visit) }),
  source: { entity: VisitSpec, into: 'items' },
  actions: { cancel },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((v) => line(v, ctx))].filter(Boolean).join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) => spokenList(p.items.map((v) => v.title), labels, ctx),
});

export const VisitCardView = defineView({
  name: 'visit.card',
  description: 'One site visit: what for, where, when and its status.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ id: z.string(), item: Visit }),
  source: { entity: VisitSpec, into: 'item', by: 'id' },
  actions: { cancel },
  labels: { noun },
  text: (p, ctx) => [p.item.title, p.item.address, when(p.item, ctx)].join('\n'),
  speak: (p, ctx) =>
    p.item.startsAt && p.item.status === 'confirmed'
      ? `${p.item.title}, ${spokenWhen(p.item.startsAt, ctx.timeZone, ctx.lang)}.`
      : `${p.item.title}, ${pick(STATUS[p.item.status], ctx.lang)}.`,
});
```

Register both views in `uiDomain.views` in `packages/ui-registry/src/domain/index.ts`, and export them from there.

The registry adds checks of its own:

- **Speakable list views need words.** `createRegistry` refuses a `by: 'query'` view that has the `speech` surface but no `labels.noun` and `labels.empty`.
- **Queries are checked against the entity.** `checkPresent` validates a list view's query with `listInputSchema`. `{ address: 'x' }` is an error, because `address` is searchable but not filterable.
- **The assistant never writes the fetched data.** `agentProps(view)` omits `source.into` from the props.

The view test (`packages/ui-registry/src/domain/visits.test.ts`) pins the exact words:

```ts
expect(VisitListView.text({ items }, en)).toBe(
  [
    '• Kitchen tiles, 12 Road No. 3, Banjara Hills (waiting for a time)',
    '• Garden wall, 12 Road No. 3, Banjara Hills (Fri 9 Oct, 16:30)',
  ].join('\n'),
);
expect(VisitListView.speak({ items }, en)).toBe('2 site visits: Kitchen tiles, Garden wall.');
expect(VisitListView.speak({ items: [] }, { ...en, lang: 'hi' })).toBe('कोई साइट विज़िट नहीं।');
```

```bash
pnpm --filter @app/ui-registry test
```

**What you get for free at this step.** A `list-visits` result on WhatsApp is turned into words with `text`. The rows also become `choices`, so a customer can tap one. This is the real `/api/chat/once` result from the scripted model:

```json
{"tool":"list-visits","ok":true,"outcome":"done",
 "present":{"kind":"text","text":"• Kitchen tiles, 12 Road No. 3, Banjara Hills (waiting for a time)",
            "choices":[{"id":"89fc54a7-…","title":"Kitchen tiles"}]}}
```

On a voice turn, the model is given `speak`'s short form in the turn's language.

---

## Step 5. Notifications: the confirmation and the reminder

WhatsApp delivers only approved templates outside the 24-hour window. Everything the business sends on its own initiative is therefore a template. `packages/notifications` holds definitions only (rule `notifications-are-definitions`). The API decides consent, quiet hours, language, channel and fallback.

```ts
// packages/notifications/src/domain/visits.ts
import { spokenWhen } from '@app/i18n';
import { z } from 'zod';
import { defineNotification, type Row } from '../define-notification.js';
import { defineTemplate } from '../define-template.js';

export const SiteVisitConfirmed = defineTemplate({
  name: 'site_visit_confirmed_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(60), time: z.string().max(60) }),
  body: {
    en: 'Your site visit for {{title}} is confirmed for {{time}}.',
    hi: '{{title}} के लिए आपकी साइट विज़िट {{time}} पर पक्की हो गई है।',
    te: '{{title}} కోసం మీ సైట్ విజిట్ {{time}}కి ఖరారైంది.',
  },
  example: { title: 'Kitchen tiles', time: 'Thursday 8 October at 4:30 pm' },
});

export const SiteVisitReminder = defineTemplate({
  name: 'site_visit_reminder_v1',
  category: 'utility',
  params: z.object({ title: z.string().max(60), address: z.string().max(100), time: z.string().max(60) }),
  body: {
    en: 'Reminder: our team visits {{address}} for {{title}} at {{time}}.',
    hi: 'रिमाइंडर: हमारी टीम {{title}} के लिए {{time}} पर {{address}} आएगी।',
    te: 'రిమైండర్: మా బృందం {{title}} కోసం {{time}}కి {{address}}కి వస్తుంది.',
  },
  example: { title: 'Kitchen tiles', address: '12 Road No. 3, Banjara Hills', time: '4:30 pm' },
});
```

`defineTemplate` throws at load (`Template <name>: …`) in any of these cases:

- the name is not `snake_case_vN`
- a language is missing or blank, or a body is over 1,024 characters
- a body's `{{placeholders}}` differ from the params schema
- there are more than three quick replies, or a marketing template has no opt-out
- the example does not fit the schema

```ts
type VisitRow = Row & {
  title: string; address: string; startsAt: string | null;
  status: string; ownerId: string; customerId: string | null;
};
const HOUR = 60 * 60_000;
/** Template params have length limits: shorten long values rather than fail the send. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The customer, or the owner when staff made the visit for nobody in particular. */
const customerOrOwner = (v: VisitRow) =>
  v.customerId ? [{ customerId: v.customerId }] : [{ userId: v.ownerId }];

export const VisitConfirmedNotification = defineNotification<VisitRow>({
  key: 'visit.confirmed',
  topic: 'service',
  send: { on: ['visit.confirmed'] },
  when: (v) => v.status === 'confirmed' && v.startsAt !== null,
  to: customerOrOwner,
  channels: ['whatsapp'],
  whatsapp: {
    template: SiteVisitConfirmed,
    params: (v, r) => ({ title: cut(v.title, 60), time: cut(spokenWhen(v.startsAt as string, r.timeZone, r.lang), 60) }),
  },
  dedupe: (v) => `visit.confirmed:${v.id}`,
});

/** An hour before a confirmed visit; moved when its time changes, gone when it is cancelled. */
export const VisitReminderNotification = defineNotification<VisitRow>({
  key: 'visit.reminder',
  topic: 'reminders',
  schedule: {
    on: ['visit.confirmed', 'visit.updated'],
    at: (v) =>
      v.status === 'confirmed' && v.startsAt ? new Date(new Date(v.startsAt).getTime() - HOUR) : null,
    cancelOn: ['visit.cancelled', 'visit.deleted'],
  },
  to: customerOrOwner,
  channels: ['whatsapp'],
  whatsapp: { template: SiteVisitReminder, params: (v, r) => ({ /* title, address, time */ }) },
  dedupe: (v) => `visit.reminder:${v.id}`,
});
```

Then add the templates to `domainTemplates` and the notifications to `domainNotifications` in `packages/notifications/src/domain/index.ts`.

How the pieces connect:

- **Events.** `NotifyService` (`apps/api/src/channels/notify/notify.service.ts`) subscribes to every `NamedEvent` on the event bus. That covers entity events (`visit.updated`) and your own (`visit.confirmed`, `visit.cancelled`). The row is passed as JSON, so dates arrive as ISO strings.
- **`schedule.at`.** Returning `null`, or a time in the past, cancels any scheduled job. `cancelOn` removes it. A new time replaces it, and the `dedupe` key makes that work.
- **Topics.**
  - `service`: on until STOP, and it ignores quiet hours.
  - `reminders`: on until STOP or "stop reminders", and moved out of quiet hours. The defaults are `21:00`–`09:00`, `Asia/Kolkata`.
  - `marketing`: needs an explicit yes.
- **Send-time checks.** At send time, the dispatcher checks, in order:
  1. that the contact is reachable
  2. consent for the topic
  3. the marketing cap
  4. that the template is approved in the reader's language, otherwise in English
  5. that the business has a WhatsApp number

  Feature code never sends a message itself.
- **Channels.** These notifications use `channels: ['whatsapp']` only. A customer who has only a WhatsApp number has no email address, and email needs a user with one.

Send the templates for review and check them. Both commands run the built CLI (`dist/channels/templates/cli.js`), so build first:

```bash
pnpm build
pnpm templates:sync     # created   site_visit_confirmed_v1 (pending review) …  (whaloc approves after 2 s)
pnpm templates:check    # every template a notification uses is approved
```

> **Pitfall: an approved template is never edited.** Once a template has been sent for review, changing its body makes `templates:sync` fail with `site_visit_reminder_v1 (en) changed since it was sent for review: bump the version (…_v2)`.

> **Pitfall: choose the reminder lead time with your tests in mind.** The golden runner's `${soon.startsAt}` is two hours ahead. A reminder "two hours before" would be scheduled in the past, which `NotifyService.schedule` treats as a cancel. With one hour, `fire:` works. The runner's variables have no time for "one hour before `${soon.startsAt}`" (`soon.reminderAt` is 30 minutes before), so the golden file promotes the job with `fire` and does not assert its time with `expectScheduled`.

---

## Step 6. Teach the assistant (agent domain, scripted model, evals)

You don't write any tools. They come from the specs. You add three things:

- the domain's rules for the live model
- scripts, so the scripted model (`MODEL_MODE=fake`) can play a conversation in tests and demos
- eval cases

### Persona and rules

```ts
// packages/agents/src/domain/index.ts (changed lines)
persona:
  'You are a meetings assistant. You help the user plan meetings, keep notes, track action items, and arrange site visits.',
rules: [
  // …the meeting rules…
  'A customer asking for a site visit: call create-visit with what it is for (title) and the address. Never promise a time: the team confirms it.',
  'Cancelling a confirmed site visit waits for the team; say so when cancel-visit returns needs_approval.',
],
help: 'I can add, list, complete or delete to-dos, show today, close or move meetings, and book or cancel site visits.',
scripts: [...visitScripts, ...domainScripts],
evalCases: [...evalCases, ...visitEvalCases],
```

> **Pitfall: keep the start of `help`.** `apps/api/test/whatsapp/conversations/07-off-topic.yaml` expects the off-topic answer to contain `I can add, list`. Extend the sentence; don't rewrite it.

### Scripts for the scripted model

A script matches the person's message, then works step by step:

1. If its tool has not run yet this turn, it calls the tool.
2. On the next model step it sees the result and answers.

The first script that matches wins, after the platform scripts.

```ts
// packages/agents/src/domain/visits.ts
import { call, defineScript, items, type Row, say, sayIn } from '../fake/engine.js';

type Visit = Row & { address: string; status: string };

const BOOK =
  /^(?:please )?(?:book|request|i (?:need|want)) (?:a )?site visit (?:for )?(.+?) at (.+?)\.?$/i;
const LIST = /^(?:show |list )?my (?:site )?visits\??$/i;
const CANCEL = /^(?:please )?cancel (?:my|the) (?:site )?visit(?: for (.+?))?\.?$/i;

const quoted = (title: string) => `"${title}"`;

export const visitScripts = [
  defineScript({
    name: 'book-visit',
    match: (text) => {
      const m = BOOK.exec(text.trim());
      return m ? { title: m[1], address: m[2] } : undefined;
    },
    step: (visit, turn) => {
      const r = turn.result('create-visit');
      if (!r) return [call('create-visit', visit)];
      return [
        sayIn(turn, {
          en: `I've asked for a site visit for ${quoted(visit.title)} at ${visit.address}. The team will confirm a time with you here.`,
          hi: `…`,
          te: `…`,
        }),
      ];
    },
  }),
  defineScript({
    name: 'list-visits',
    match: (text) => (LIST.test(text.trim()) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-visits');
      if (!r) return [call('list-visits', {})];
      if (turn.spoken && r.speech) return [say(r.speech)];
      const n = items(r).length;
      return [
        sayIn(turn, {
          en: n ? `You have ${n} site visit${n === 1 ? '' : 's'}.` : 'You have no site visits.',
          hi: '…',
          te: '…',
        }),
      ];
    },
  }),
  defineScript({
    name: 'cancel-visit',
    match: (text) => {
      const m = CANCEL.exec(text.trim());
      return m ? { title: m[1] } : undefined;
    },
    step: ({ title }, turn) => {
      const done = turn.result('cancel-visit');
      if (done) {
        const result = done.result as { status: string; value?: Visit };
        if (result.status === 'needs_approval')
          return [sayIn(turn, { en: 'That visit is already confirmed, so cancelling it needs the team’s OK.', hi: '…', te: '…' })];
        return [sayIn(turn, { en: `Cancelled the site visit for ${quoted(result.value?.title ?? '')}.`, hi: '…', te: '…' })];
      }
      // Look before changing: the id comes from the list, never from the words.
      const list = turn.result('list-visits');
      if (!list) return [call('list-visits', { status: { in: ['requested', 'confirmed'] } })];
      const open = items(list) as Visit[];
      const target = title
        ? open.find((v) => v.title.toLowerCase().includes(title.toLowerCase()))
        : open.length === 1 ? open[0] : undefined;
      if (!target) return [sayIn(turn, { en: 'You have no open site visits.' /* or "Which visit?" */, hi: '…', te: '…' })];
      return [call('cancel-visit', { visitId: target.id })];
    },
  }),
];
```

The `list-visits` script is what eval case 17 (`my site visits`) and the app's `my site visits` suggestion rely on.

- **Don't use `written()` for a customer's parked request.** The helper in `fake/engine.ts` answers a parked English write with "I've asked for **your** approval…". That is right for an owner's own assistant, but wrong for a customer whose request goes to the team.
- **WhatsApp adds the team line.** `InboundProcessor.converse` appends `approval.askedTeam` ("I've asked the team to confirm. I'll tell you here when they do.") to any reply whose approval has no single approver. Your own reply should explain *why* the cancel waits, not repeat that.
- **The scripted model reads the system prompt.** It finds the language and surfaces with regexes. `Reply in <Language>.` comes from `packages/agents/src/assistant.ts` and `Surfaces: …` from `INSTRUCTIONS` in `packages/agents/src/version.ts`. Your rules can add lines, but if you edit either wording, scripted tests can break silently.

Try it through the chat endpoint (a real response from the scripted model):

```bash
api $API/api/chat/once -d '{"message":"book a site visit for Kitchen tiles at 12 Road No. 3, Banjara Hills"}'
# {"reply":"I've asked for a site visit for \"Kitchen tiles\" at 12 Road No. 3, Banjara Hills. The team will confirm a time with you here.",
#  "runId":"c0d5…","threadId":"2728…","toolCalls":[{"tool":"create-visit","ok":true,"outcome":"done"}]}
```

### Eval cases

```ts
// packages/agents/src/domain/evals.ts
export const visitEvalCases: EvalCase[] = [
  {
    why: 'asks for a site visit with what it is for and where',
    input: 'book a site visit for Kitchen tiles at 12 Road No. 3, Banjara Hills',
    expect: { must: ['create-visit'], replyIncludes: 'Kitchen tiles' },
  },
  { why: 'lists visits', input: 'my site visits', expect: { must: ['list-visits'], mustNot: ['cancel-visit'] } },
  {
    why: 'cancels a requested visit at once, using an id from the list',
    input: 'cancel my site visit for Kitchen tiles',
    expect: { must: ['list-visits', 'cancel-visit'], replyIncludes: 'Cancelled' },
  },
  {
    why: "doesn't cancel a visit that isn't there",
    input: 'cancel my site visit for a boat',
    expect: { must: ['list-visits'], mustNot: ['cancel-visit'] },
  },
];
```

The evals call a **running** API (`API_INTERNAL_URL`, default `http://localhost:3000`). Each case is checked by three scorers:

| Scorer | What it checks |
|---|---|
| `expectedOutcome` | The tools in `must`, in order, none of `mustNot`, and the reply text. |
| `listBeforeWrite` | A write to a record comes after a list or get. `cancel-visit` comes after `list-visits`. |
| `noRetryAfterRefusal` | The model does not try again after a refusal. |

```bash
pnpm --filter @app/agents eval
# PASS  16. asks for a site visit with what it is for and where  "book a site visit for Kitchen tiles at …"
# PASS  17. lists visits  "my site visits"
# PASS  18. cancels a requested visit at once, using an id from the list  "cancel my site visit for Kitchen tiles"
# PASS  19. doesn't cancel a visit that isn't there  "cancel my site visit for a boat"
# 19/19 turns passed. Scores and traces are in Studio.
```

`pnpm --filter @app/agents eval:live` runs the same cases against the real model (it needs `OPENROUTER_API_KEY`).

---

## Step 7. The app: where staff confirm

The mobile app derives its data hooks from the same specs, so you need no client code for requests. You add a screen and bind the views.

### A Visits screen with the confirm command

```tsx
// apps/mobile/src/app/(domain)/visits.tsx (excerpt)
import { CancelVisitSpec, ConfirmVisitSpec, type Visit } from '@app/contracts';
import { errorMessage, useCommand, useEntityList } from '../../framework/hooks';

const chips: Chip[] = [
  { label: 'To confirm', query: { status: 'requested', sort: 'createdAt' } },
  { label: 'Confirmed', query: { status: 'confirmed', sort: 'startsAt' } },
  { label: 'All', query: { sort: '-createdAt' } },
];

function Confirm({ visit }: { visit: Visit }) {
  const confirm = useCommand(ConfirmVisitSpec);
  const [date, setDate] = useState(todayLocal());
  const [time, setTime] = useState('10:00');
  return (
    <View style={[styles.row, { flexWrap: 'wrap', alignItems: 'flex-end' }]}>
      <DateField label="Date" value={date} onChange={setDate} />
      <TimeField label="Time" value={time} onChange={setTime} />
      <Button
        title="Confirm"
        busy={confirm.isPending}
        disabled={!(isValidDate(date) && isValidTime(time))}
        onPress={() => confirm.mutate({ visitId: visit.id, startsAt: at(date, time) })}
      />
    </View>
  );
}

export default function Visits() {
  useScreenContext({ screen: 'visits' });
  const [chip, setChip] = useState(chips[0]);
  const list = useEntityList('visits', chip.query);
  // …FlatList of VisitRow: <Confirm> for requested, <Cancel> (useCommand(CancelVisitSpec)) for confirmed
}
```

- `useCommand(spec)` posts to the spec's route and invalidates every entity query on success.
- `useEntityList('visits', query)` is typed by the `entities` catalog. Its query uses the same list grammar as the API.

### Nav item, suggestion and inline views

```ts
// apps/mobile/src/domain/index.ts
{ href: '/visits', label: 'Visits', icon: 'map-pin', match: (p) => p.startsWith('/visits') },
// suggestions:
{ text: 'my site visits', what: 'lists the site visits' },

// apps/mobile/src/domain/bindings.tsx
bindView(VisitListView, VisitListComponent);
bindView(VisitCardView, VisitCardComponent);
```

```tsx
// apps/mobile/src/domain/views/visit.tsx (excerpt)
export function VisitListComponent({ title, items, act, words }: ViewProps<typeof VisitListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(v) => <VisitLine visit={v} onCancel={() => act('cancel', v)} />}
      </Rows>
    </ViewCard>
  );
}
```

- **A view without a component draws nothing.** `InlineView` returns `null` when `getView(name)` has no component, so an unbound view's tool result shows nothing in the chat.
- **Typed bindings.** `bindView` checks the component's props against the view's `props` at compile time.
- **Actions run as the person.** `act('cancel', v)` runs the view action through `useAct`, which here posts `visit.cancel`. A parked result shows a toast, and the app refreshes `approvals` and `history`.

```bash
pnpm turbo run typecheck --filter=@app/mobile
pnpm --filter @app/mobile dev       # http://localhost:8081 → Visits
```

---

## Step 8. Test it end to end (API)

`apps/api/test/domain/visits.e2e.test.ts` runs the whole flow against the compiled app with three actors:

| Actor | How the test creates it | How it calls the API |
|---|---|---|
| The owner | signs up | `owner.call(...)` |
| Sita, on staff | `addMember(sita, tenantId, ['staff'])` | calls with `x-tenant-id` |
| Kavya, a WhatsApp customer | `seedContact` | through her assistant, `asAssistant('contact:<id>')` |

The setup and helpers come first. Everything is imported from `apps/api/test/support.ts`, and `NotifyService` from the compiled app:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember, asAssistant, boot, eventually, me, Person, pool, seedContact, server, shutdown,
} from '../support.js';

const owner = new Person('Owner Visits');
const sita = new Person('Sita Staff');
let tenantId = '';
let kavya: { contactId: string; customerId: string };
let asKavya: ReturnType<typeof asAssistant>;
let asRavi: ReturnType<typeof asAssistant>;
/** Sita works in the owner's business: every call names it. */
const asSita = (method: string, path: string, body?: unknown) =>
  sita.call(method, path, body, { 'x-tenant-id': tenantId });

beforeAll(async () => {
  await boot();
  await owner.signUp();
  await sita.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(sita, tenantId, ['staff']);
  kavya = await seedContact(tenantId, 'Kavya', `9190${String(Date.now()).slice(-8)}`);
  const ravi = await seedContact(tenantId, 'Ravi', `9191${String(Date.now()).slice(-8)}`);
  asKavya = asAssistant(`contact:${kavya.contactId}`);
  asRavi = asAssistant(`contact:${ravi.contactId}`);
});
afterAll(shutdown);

/** When the reminder for this visit is scheduled (null: not at all). */
async function reminderAt(visitId: string) {
  const { NotifyService } = await import('../../dist/channels/notify/notify.service.js');
  return server.app?.get(NotifyService).scheduledFor(`visit.reminder:${visitId}`);
}

const inTwoDays = () => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
};
```

The cases share `visitId` and `startsAt` inside `describe('site visits', …)`. This one is the approval path:

```ts
it('the customer cancelling a confirmed visit waits for the team; staff approve it', async () => {
  const asked = await asKavya('POST', `/api/visits/${visitId}/cancel`, {});
  expect(asked.body).toMatchObject({
    status: 'needs_approval',
    approval: {
      rule: 'confirmed_visit_cancel',
      summary: 'Cancel the site visit "Kitchen tiles" at 12 Road No. 3, Banjara Hills',
    },
  });
  const approvalId = asked.body.approval.id;
  expect((await asKavya('GET', `/api/visits/${visitId}`)).body.status).toBe('confirmed');

  const pending = (await asSita('GET', '/api/approvals')).body.map((a: { id: string }) => a.id);
  expect(pending).toContain(approvalId);
  const approved = await asSita('POST', `/api/approvals/${approvalId}/approve`);
  expect(approved.body).toMatchObject({ status: 'approved' });

  expect((await asKavya('GET', `/api/visits/${visitId}`)).body.status).toBe('cancelled');
  await eventually(async () => ((await reminderAt(visitId)) === null ? true : undefined));

  const audit = await pool.query(
    `select action, outcome, actor_kind, approved_by from audit.events
     where resource_id = $1 and action = 'visit.cancel' order by at`,
    [visitId],
  );
  expect(audit.rows).toEqual([
    { action: 'visit.cancel', outcome: 'needs_approval', actor_kind: 'agent', approved_by: null },
    { action: 'visit.cancel', outcome: 'committed', actor_kind: 'agent', approved_by: sita.id },
  ]);
});
```

The other cases in the file cover:

- A customer's visit is owned by the business and carries their customer id. Another customer gets a 404.
- A plain `PATCH` of `status` is refused with `use_visit_commands`. The assistant cannot reach `confirm`.
- Staff confirm, and the reminder is scheduled exactly one hour before. `NotifyService.scheduledFor('visit.reminder:<id>')` reads it. Confirming twice is refused with `not_requested`.
- A visit that is still only requested is cancelled at once.
- The scripted assistant books and cancels in the owner's own words through `/api/chat/once`.

```bash
pnpm turbo run build --filter=@app/api...
cd apps/api && pnpm vitest run test/domain/visits.e2e.test.ts
#  Test Files  1 passed (1)
#       Tests  6 passed (6)
```

---

## Step 9. Test the WhatsApp conversation (golden file)

A golden conversation plays a real WhatsApp exchange against **whaloc-test** (port 8090). The test app listens on port 3099, with queues inline and the scripted model. The runner syncs and approves every template first, your new ones included.

```yaml
# apps/api/test/whatsapp/conversations/13-site-visit.yaml
name: a customer asks for a site visit; staff confirm it; the reminder comes; cancelling waits for the team
steps:
  - linkOwner: {}
  - say: { as: meera, text: "book a site visit for Kitchen tiles at 12 Road No. 3, Banjara Hills" }
  - expect: { to: meera, text: "/privacy/" }                       # the welcome, on a first message
  - expect: { to: meera, text: "The team will confirm a time" }
  - query:
      sql: >-
        select v.id from app.visits v join channel.contacts c on c.customer_id = v.customer_id
        where c.address = $1 and v.status = 'requested'
      params: ["${address.meera}"]
      save: visit
  - api:
      as: owner
      method: POST
      path: "/api/visits/${visit.id}/confirm"
      body: { startsAt: "${soon.startsAt}" }
  - expect: { to: meera, template: site_visit_confirmed_v1 }
  - fire: { dedupe: "visit.reminder:${visit.id}" }
  - expect: { to: meera, template: site_visit_reminder_v1 }
  - say: { as: meera, text: cancel my site visit }
  - expect: { to: meera, text: "needs the team" }
  - expect: { to: owner, template: approval_request_v1 }
  - tap: { as: owner, button: Approve }
  - expect: { to: owner, text: "Done: Cancel the site visit" }
  - expect: { to: meera, template: approval_outcome_v1 }
  - expectDb:
      sql: select status from app.visits where id = $1
      params: ["${visit.id}"]
      rows: [{ status: cancelled }]
  - expectScheduled: { dedupe: "visit.reminder:${visit.id}", at: null }
```

What the framework did on that path:

- **A new customer.** The first message created a contact, a customer and a `service` consent, then sent the welcome.
- **The approval request.** The owner's linked number received `approval_request_v1` with signed Approve and Reject buttons. The approval had no single approver, and `channels` allowed WhatsApp.
- **The outcome.** Meera received `approval_outcome_v1` because she was the requesting contact.

```bash
docker compose up -d whaloc-test
cd apps/api && pnpm vitest run test/whatsapp -t "13-site-visit"   # just this file
cd apps/api && pnpm vitest run test/whatsapp                      # all 13 conversations
```

The golden tests are skipped (`describe.skipIf`) when whaloc-test is not running, and CI does not run them.

---

## Step 10. Try it by hand: whaloc, the app, the approvals

Run everything with `pnpm dev`. It starts the API with the queue worker, the app on 8081, the back office on 8082 and the voice worker. Then:

1. **Sign up in the app** at http://localhost:8081. You are the owner of a new business.
2. **Claim the business number.** This is done once. Without it, inbound messages are dropped with `unknown number`. Run it as the owner with your session cookie:
   ```bash
   api $API/api/channels/whatsapp/number -d '{}'   # uses WA_PHONE_NUMBER_ID from .env
   ```
3. **Write as a customer.** Open whaloc at http://localhost:8080, pick any customer number and send `book a site visit for Kitchen tiles at 12 Road No. 3, Banjara Hills`. You can also post the same inbound message the golden runner sends:
   ```bash
   curl -s http://localhost:8080/api/inbound -H content-type:application/json -d '{
     "phoneNumberId":"573542517421694","from":"919800000001","profileName":"Meera",
     "type":"text","text":{"body":"book a site visit for Kitchen tiles at 12 Road No. 3, Banjara Hills"}}'
   ```
4. **Confirm it in the app.** Go to **Visits → To confirm**, pick a date and time, and press Confirm. Meera gets `site_visit_confirmed_v1` in whaloc. This needs `pnpm templates:sync` to have run.
5. **Cancel as the customer.** Meera sends `cancel my site visit`. The approval waits in the app's approvals for owner, admin, ops and staff. It is also sent to WhatsApp as `approval_request_v1` to any team member whose number is linked, but only when `APPROVAL_SECRET` is set. Approve it, and Meera is told.
6. **Look behind the scenes:**

   | Where | What you see |
   |---|---|
   | http://localhost:3000/admin/queues | Bull Board. Sign in as owner or admin first. |
   | `GET /api/history?resourceType=visit&resourceId=<id>` | The visit's history. Only ops and admin see the whole business's rows. Everyone else, the owner included, sees only what they or their own assistant did, so the owner does not see the create and cancel rows from Meera's assistant. |
   | `audit.events` in pgAdmin at http://localhost:5050 | The full audit trail, including a customer's actions. |

To see the trail for one assistant turn, query by its run id:

```sql
SELECT at, action, outcome, actor_kind, acting_for, channel, rule, reason, approved_by
FROM audit.events WHERE run_id = '<run-id>' ORDER BY at;
```

---

## Pitfalls collected

1. **Fields a command sets must be in the update schema.** Otherwise `repo.update` drops them silently. Guard them with a rule that checks `ctx.via` (step 1 and step 3).
2. **`BUSINESS_ACCESS` gives staff only their own rows.** A customer's records are owned by the default owner. If staff must act on them, give the entity its own `Access` with `'tenant'` for team roles.
3. **Entity rules can only deny.** A rule that returns `needsApproval` is ignored. For conditional approval, use a command's `authorize`. `spec.approval` covers the unconditional or principal-based cases (`approval: { delete: (p) => p.actor.kind === 'agent' }`).
4. **A command's `approval` is who decides, not whether.** Without `by`, a person decides their own assistant's request. Set `by` when the team must decide.
5. **Repo calls inside a command publish no entity events.** Publish a `NamedEvent` from `run` for notifications to react to.
6. **Tests run `dist/`.** Run `pnpm turbo run build --filter=@app/api...` before `vitest run`.
7. **Templates are versioned forever.** Changing a body means a new `_vN`, then `templates:sync`.
8. **The scripted model's wording matters.** Keep the start of `help` (`07-off-topic.yaml`). Write your own reply for parked customer requests rather than using `written()`.
9. **One database, many processes.** `OutboxRelay` relays every unrelayed `app.outbox` row in the database, whatever process wrote it. Do not run a `pnpm dev` worker from another checkout against the same database while you run the API tests. It will steal outbox rows: `framework/notifications.e2e.test.ts` then fails waiting for a message the other worker sent through the dev whaloc. The same applies to migrations: apply them from one branch only.
10. **A fresh worktree or clone needs `pnpm install` and a `.env`.** The API and the tests read the root `.env` (`--env-file=../../.env`, `loadEnv('test', '../..')`).
11. **Quiet hours move reminders.** `topic: 'reminders'` is rescheduled out of quiet hours. `service` is not. The golden runner disables quiet hours for its business, but your dev business keeps the defaults.

---

## Checklist

- [ ] **Contracts:** `entitySpec` with schemas (any status field that commands set is in `update`), `label`, `fieldLabels` in en/hi/te, `list`, `expose` and `views`. Each command has a `commandSpec` with `http`, `tool` (or none), `expose`, `approvalNote`, `view`, `verb` and `touches`.
- [ ] **Contracts index:** the entity is added to `defineDomain({ entities })` under its plural, and the commands to `commands`. The new file is re-exported.
- [ ] **Database:** the table in `packages/db/src/schema/domain.ts` has `id()`, `tenantColumn()`, an owner column, `customerColumn()`, `createdBy`, `createdAt` and `updatedAt`. The migration was generated with `pnpm --filter @app/db generate --name <name>` and applied with `pnpm db:migrate`. The SQL, the snapshot and the journal are committed.
- [ ] **API entity:** `defineEntity` with `table`, `owner`, `customer`, `access` and `rules` (deny-only, `ctx.via` for command-only fields).
- [ ] **API commands:** `defineCommand` with `resource`, a scoped `load`, `authorize` (`allow`, `deny`, `needsApproval`), `summarize`, a `run` that passes `via` and returns `touched` and `events`, and `approval: { by }` when the team decides.
- [ ] **Nest:** a module with `entityController`, `entityHandlers`, `commandController` and `commandHandler`, added to `DomainModule`.
- [ ] **Views:** `defineView` list and card with `text`, `speak`, `labels.noun` and `labels.empty`. Registered in `uiDomain`, with a view test.
- [ ] **Notifications:** `defineTemplate` (versioned name, en/hi/te, an example) and `defineNotification` (`send.on` or `schedule`, `cancelOn`, `topic`, `to`, `channels`, `dedupe`). Registered in `domainTemplates` and `domainNotifications`. `pnpm templates:sync` and `pnpm templates:check` pass.
- [ ] **Assistant:** persona and rules updated, the `help` prefix kept, scripts added before `domainScripts`, eval cases added. `pnpm --filter @app/agents eval` passes with the API running.
- [ ] **App:** a screen in `apps/mobile/src/app/(domain)/`, a nav item, and `bindView` for each view. `pnpm turbo run typecheck --filter=@app/mobile` passes.
- [ ] **Tests:** an e2e test in `apps/api/test/domain/` and a golden YAML in `apps/api/test/whatsapp/conversations/`. Both pass with `cd apps/api && pnpm vitest run <file>`.
- [ ] **Repository checks:** `pnpm turbo run build typecheck test`, `pnpm lint` and `pnpm lint:deps` all pass.
