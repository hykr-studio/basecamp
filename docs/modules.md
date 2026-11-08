# Working on modules in parallel

An application is a list of modules, and each module is a folder that one person, one team or
one coding agent can build while others build theirs. This guide is the procedure: how to start
a module, what it owns, how the files every module touches are merged, how the one migration
journal stays straight, and how to test and evaluate one module on its own.

The mechanisms are in the [developer guide](developer-guide.md), section 5.11; what each layer
of a module exports is in [DOMAIN.md](../DOMAIN.md). Commands below run from the repository root
unless they say otherwise, after `pnpm build`.

## 1. Start a module

```bash
pnpm --dir application exec basecamp module add widgets            # entity: widget
pnpm --dir application exec basecamp module add news --entity story  # when the plural is not <entity>s
```

```text
created     domain/src/modules/widgets/contracts/widget.ts
created     domain/src/modules/widgets/contracts/index.ts
created     domain/src/modules/widgets/db/schema.ts
created     domain/src/modules/widgets/server/widget.entity.ts
created     domain/src/modules/widgets/server/widgets.module.ts
created     domain/src/modules/widgets/server/public.ts
created     domain/src/modules/widgets/views/widget.ts
created     domain/src/modules/widgets/views/index.ts
created     domain/src/modules/widgets/notifications/index.ts
created     domain/src/modules/widgets/agent/index.ts
created     domain/src/modules/widgets/index.ts
created     mobile/src/modules/widgets/views.tsx
created     mobile/src/modules/widgets/index.tsx
created     mobile/src/modules/widgets/routes.ts
created     mobile/src/modules/widgets/screens/Widgets.tsx
created     mobile/src/app/widgets/index.tsx
registered  domain/src/modules/index.ts
registered  domain/src/contracts/index.ts
registered  domain/src/views/index.ts
registered  mobile/src/modules/index.ts

Next:
- Generate the migration for its table: basecamp db generate --name widgets
- Its words are English only (other languages read them in English): add the application's
  other languages (Hindi, Telugu) to the labels in …/views/widget.ts and …/contracts/widget.ts.
```

Everything it writes builds as it is: one entity with a title, its table, a list view, a list
screen, and empty notifications and agent parts to fill in. A module's name is lower case
(`[a-z][a-z0-9_]*`), never `platform` (the framework's own), and usually the plural of its first
entity. Then:

```bash
pnpm db:generate --name widgets      # the module's table, in the one journal (section 5)
pnpm db:migrate
pnpm turbo run build typecheck --filter=@application/api... --filter=@application/mobile
```

## 2. What a module owns

Everything under `application/domain/src/modules/<name>/` and
`application/mobile/src/modules/<name>/`, plus its route files under
`application/mobile/src/app/<name>/`. Inside the running application
it also owns names, and `defineServer` refuses two modules (or a module and the framework) with
the same one:

| A module declares | So nobody else may use |
|---|---|
| Entities and commands | Their names and plurals, their routes (`/api/<plural>`, a command's `http`), their tool ids, their approval ops |
| Tables (`db/schema.ts`) | The table names, which must be the module's name or start with it: `widgets`, `widgets_parts` |
| Views and screens | Their names (`widget.list`) |
| Templates and notifications | Template names (`widget_ready_v1`) and notification keys |
| Contributions (`contributes`) | The names in their registries: capabilities and roles, queues and schedules, subscribers, flags, documents, jobs. Prefix them with the module (`widgets.approve`, `widgets.nightly`) |

The framework holds names too. Its routes are reserved under `/api/` (`approvals`, `files`, `jobs`,
`documents`, `members`, `shares` and the others each feature reserves with `reserveRoutes`), and
its tables are in the same `app` schema: a module called `jobs` collides with the framework's
long-running jobs on both. When modules do not fit, the server does not start, and one
`ModulesError` lists every problem. To see it without starting anything:

```bash
pnpm turbo run build --filter=@application/api...
node -e "import('./application/api/dist/server.js').catch((e) => console.error(e.message))"
```

A module is also a unit the framework can switch and scope: a feature flag can gate a whole
module (`defineFeatureFlag({ gates: { modules: ['widgets'] } })`, guide 5.18), an MCP client is
granted `widgets:read` or `widgets:write` (guide 7.8), and `basecamp eval --module widgets` runs
its evals alone (section 6).

## 3. Boundaries between modules

- **Depend explicitly.** A module lists the modules it builds on in its `moduleSpec({ dependsOn })`,
  and `modules/index.ts` lists it after them. Modules form no cycle.
- **Import only the public parts.** From another module, import its `contracts/` (specs, types,
  capabilities) or its `server/public.ts` (what it lets others call on the server, usually its
  entity defs), and only from a module in your `dependsOn`. Never its `db/`, `agent/`, other
  `server/` files, or the lists of modules.
- **Write another module's records through its entity.** A command in `meetings` writes a note with
  `Note.repo.insert(tx, p, …, via)` from `notes/server/public.ts`: inside the command's own
  transaction, through that entity's access, rules, plugins and audit, and listed in `touched`.
  To react to another module without depending on it, subscribe to its stored events
  (`defineSubscriber({ on: ['note.created'] })`, guide 5.10).
- **Point down the graph by name.** A table that refers to a module that depends on yours (a
  note's `meeting_id`, while `meetings` depends on `notes`) uses `tableRef('meetings').id` from
  `@hykr/db`, never an import of that module.
- **Keep the isomorphic folders isomorphic.** `contracts/`, `views/` and `notifications/` are read
  by the server and the apps: no Nest, Drizzle, Mastra or BullMQ, and no `server`, `db` or `agent`
  folder of any module.
- **The app half imports only modules' contracts and views**, through
  `@application/domain/contracts`, `@application/domain/views`, or one module's
  `@application/domain/modules/<name>/contracts` and `/views`. Another app module is used through
  its `index.tsx` only (not checked by a rule yet: guide 14).

`pnpm lint:deps` enforces them, except the one about another app module's `index.tsx`, with the
rules `module-imports-public-parts`, `module-<name>-imports-its-dependencies` (generated from
each module's `dependsOn`), `module-not-to-aggregates`, `no-module-cycles`,
`domain-specs-and-views-are-isomorphic` and `apps-read-only-isomorphic-domain`.

What no single module owns lives in `application/domain/src/server/` (who reaches which rows,
the approval levels, the privacy policy), `application/domain/src/languages.ts`,
`application/api/src/server.ts` (the persona, `help`, `channel.does`) and
`application/mobile/src/{settings,catalog}.ts` and `home/`. A change there touches every module:
agree it with the others, and keep it in a commit of its own.

## 4. The files every module touches

Adding a module adds one line to each of four lists:

- `application/domain/src/modules/index.ts` (the server's `modules`, in dependency order),
- `application/domain/src/contracts/index.ts` (`moduleSpecs`, for the apps),
- `application/domain/src/views/index.ts` (`moduleViews`, for the apps),
- `application/mobile/src/modules/index.ts` (the app modules).

Each list ends with a `// basecamp module add: …` line, and `module add` puts the new entry above
it and the import in sorted order, so every entry stays on its own line. `.gitattributes` merges
these files with `merge=union`: two branches that each added a module merge (or rebase) without a
conflict, both lines kept. After such a merge run `pnpm format` (it puts the lines back in
order) and the build. A union merge keeps both sides of any hunk the branches both changed, so
when one branch renames a module another removed, both lines stay: read the lists after it.

The same holds for the framework's own barrels (one line per feature, script set or message
file), listed in `.gitattributes`.

## 5. One migration journal

Every module's tables are in one journal, `application/domain/drizzle/` (recorded in
`drizzle.__app_migrations`), generated by drizzle-kit from `src/modules/*/db/schema.ts`. Two
branches that each generate a migration both take the journal's next number, from the same
snapshot. Merged as they are, the journal collides, and drizzle silently skips a migration whose
time is older than the last one a database applied. So:

1. **Generate on your branch, for your own database.** `pnpm db:generate --name <change>`, then
   `pnpm db:migrate`. Never edit a file under `drizzle/` by hand. Change your own module's
   tables only, and only additively while others are building on them (new tables, nullable or
   defaulted columns, indexes): a rename or a drop makes drizzle-kit ask questions, and breaks
   whoever has applied the old shape.
2. **Rebase (or merge) the base branch in.** Conflicts under `application/domain/drizzle/` are
   expected: take the base's side for every file there, because the next step rewrites the
   folder anyway. In a rebase the base is "ours":

   ```bash
   git rebase origin/main
   git checkout --ours -- application/domain/drizzle   # in a merge: --theirs
   git add application/domain/drizzle && git rebase --continue
   ```

3. **Generate your migration again on top of the base's.**

   ```bash
   pnpm --dir application exec basecamp db rebase --base origin/main   # default base: main
   # dropped 0009_widgets.sql; generating widgets on origin/main
   # A database that applied the dropped migrations must be recreated before db migrate.
   # [✓] Your SQL migration file ➜ drizzle/0010_widgets.sql 🚀
   ```

   It puts `drizzle/` back to what the base has, deletes the migrations the base does not have,
   and runs drizzle-kit again, named after the migration it dropped (or `--name`). Run with
   nothing to drop, it says so and does nothing.
4. **Recreate a database that applied your old migration**, then `pnpm db:migrate`, and commit
   the regenerated files.

`pnpm db:migrate` holds an advisory lock, so two migrates on one database wait for each other,
and it refuses to start when a migration was never applied but is older than the last one
applied, naming it: that is a step 3 that was missed.

What drizzle-kit does not generate (extensions, triggers, CHECK constraints) goes in the
application's SQL hooks, `application/domain/sql/pre/*.sql` and `sql/post/*.sql`, run around the
migrations on every migrate, in name order, one transaction per file. Each must be idempotent.
Name each file after its module (`orders-states.sql`), so two modules never edit one file.

## 6. Tests and evals, one module at a time

| What | Where | Run |
|---|---|---|
| Unit tests (views' `text` and `speak`, notifications) | `application/domain/src/modules/<name>/**/*.test.ts` | `cd application/domain && pnpm vitest run src/modules/<name>` |
| End-to-end tests (routes, scoping, approvals, chat with the scripted model) | `application/api/test/domain/<name>*.e2e.test.ts` (name them after the module) | `pnpm turbo run build --filter=@application/api...`, then `cd application/api && pnpm vitest run test/domain/<name>` (a path filter: every file whose path contains it) |
| Assistant evals | the module's `agent/evals.ts` (`evalCases`, `voiceEvalCases`, `evalSetup`) | `cd application && pnpm exec basecamp eval [assistant\|voice\|whatsapp] --module <name>`, with the API running |
| Every module together | | `pnpm test`, and `pnpm eval` with the API running |

An eval run makes a fresh user, runs only that module's `evalSetup`, then its cases in order.
An unknown module fails (`No module called …`), and so does a run in which no case ran (a module
with no voice cases, for `eval voice`: `<module> has no spoken eval cases …`); `eval whatsapp`
types a module's spoken cases that are not in English. Since the first matching script takes a
turn, earlier modules first, `defineServer` runs every module's eval inputs through all the
modules' scripts and refuses to start when one module's script would take another's turn: give
each module verbs of its own.

The evals call the API at `API_INTERNAL_URL` (default `http://localhost:3000`) and sign up their
user with that address as the request's origin. An API on another port (a second checkout) needs
`PORT`, `API_INTERNAL_URL` and `BETTER_AUTH_URL` all set to it, in the API's environment and the
eval's.

## 7. One checkout, one database, one queue prefix

Parallel work shares Postgres, Redis and the emulators of `pnpm infra:up`, so each piece of work
needs its own:

- **database** (`DATABASE_URL` and `MIGRATE_DATABASE_URL`): migrations from two branches on one
  database are what section 5 guards against;
- **queue prefix** (`BULL_PREFIX`): the rows a write leaves for the worker, sends in `app.outbox`
  and stored events in `app.domain_events`, carry the prefix of the process that wrote them, and
  a worker relays only its own. Two workers with the same prefix on one database run each other's
  jobs with their own code. Each test run makes a fresh prefix;
- **ports** (`PORT`, and the others above), when it runs an API.

In this repository, `scripts/wt.sh` does it for a git worktree: `wt.sh init <id>` makes
`../basecamp-wt/<id>` on branch `gap/<id>` from `BASE_BRANCH`, a database `app_<id>` copied from
the template database `app_tpl` (the base branch's schema, `wt.sh tpl` rebuilds it), and a `.env`
with its own `BULL_PREFIX`; `wt.sh resetdb <id>` recreates the database; `wt.sh test <id>
[turbo args]` runs tests with at most two suites at once on the machine; `wt.sh check <id>` fails
when the branch commits generated migrations (in this repository's parallel runs, the integrator
generates them at merge) or `framework/` holds product vocabulary; `wt.sh rm <id>` removes the
worktree and its database.

## 8. Before you hand a module over

- [ ] Its four registration lines are in, and `dependsOn` names every module it imports.
- [ ] `pnpm turbo run build typecheck --filter=@application/api... --filter=@application/mobile`
- [ ] `pnpm lint`, `pnpm lint:deps`
- [ ] Its unit and e2e tests pass, and `basecamp eval --module <name>` passes.
- [ ] Its migration was generated after the latest base (section 5), and a database migrated from
      scratch takes it (`pnpm db:migrate`).
- [ ] New templates are synced (`pnpm templates:sync`) and approved (`pnpm templates:check`).
- [ ] What it adds that a business or the framework must know is in [DOMAIN.md](../DOMAIN.md)
      and the guides.
