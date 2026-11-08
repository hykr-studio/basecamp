# HDOCS: the documentation, consolidated for modules and every new primitive

## Summary

A documentation unit. Forty-odd units changed the framework and the sample on
`feat/platform-gaps`, and each wrote its own paragraphs of the guides. HDOCS reads the guides as
one set, against the merged code:

- `README.md`: what is inside (every primitive the gaps added), the repository layout (the
  module folders, `@hykr/connectors`), getting started, and every script and `basecamp` command.
- `DOMAIN.md`: the module layout and what each module and each application layer exports.
- `docs/developer-guide.md`: architecture, the new primitives (each with a short recipe in
  section 10), the rules of the road, testing, the definition of done, and section 14 ("Not
  ready yet") reduced to what is really missing.
- `docs/new-application.md`: the modular structure, and the files of a new product as the
  current framework wants them.
- `docs/tutorial.md`: still correct, checked by replaying it.
- `CLAUDE.md`: commands and architecture, concise.
- A new `docs/modules.md`: working on modules in parallel (`module add`, boundaries, the one
  shared journal and the rebase then regenerate procedure with `basecamp db rebase`, per-module
  evals and tests).

No framework or sample code changes.

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | Documentation only. A claim the code contradicts is corrected in the guide; a defect in code found while checking is reported (below, and as a known gap), not fixed here: the code belongs to other units. | Brief ("Consolidate the documentation"); plan, hot files rule. |
| 2 | Files changed: `README.md`, `DOMAIN.md`, `CLAUDE.md`, `docs/developer-guide.md`, `docs/new-application.md`, `docs/tutorial.md`, the new `docs/modules.md`, and this file. Other units' decisions docs are their history and stay as they are; `docs/decisions/README.md` (the assumptions register) belongs to the report phase. | Brief; plan, phase 5. |
| 3 | Every command these files document is run in the HDOCS worktree, on its own database and queue prefix. Commands that change the tree (`basecamp module add`, `db generate`, `db rebase`) run on a throwaway branch that is deleted afterwards. Commands this worktree may not run (`pnpm infra:up`/`down`, `pnpm dev`, `basecamp dev`, the golden WhatsApp conversations, which reach whaloc-test only from the main checkout, the native apps and Maestro, `npm create` from the registry) are checked against the code that runs them and listed under "Not run here" below. | Brief ("Check every command you document by running it"); worktree rules (no infra, no `pnpm dev`). |
| 4 | Both tutorials are replayed against the current framework on throwaway branches: the tutorial's `visits` module added to the sample, and Fixit's `jobs` module replacing the sample. Each replay builds, typechecks and runs the tutorial's own tests and evals; what does not hold is corrected in the tutorial. The replays use the workspace's packages, not packed tarballs: the CI `consumer` job covers packing. | Brief ("tutorial.md: still correct"); default: a tutorial is correct only if its files still build and pass. |
| 5 | Section 14 lists only what is missing. Rows that describe what works ("Hooks that run", "Plugin slots in use") leave section 14; what they say that is useful moves to the section about it. Rows whose gap has been closed since go; rows partly closed are trimmed. | Brief ("section 14 updated to the truth"); H6 decision 4. |
| 6 | `docs/modules.md` is the procedure for parallel work; `DOMAIN.md` stays the reference for what each layer exports; guide 5.11 stays the reference for the module mechanisms. Each links the others instead of repeating them. | Brief; default: one place per fact. |
| 7 | The stale outbox pitfall: the original CLAUDE.md said a dev worker from another checkout "takes outbox rows and the notification tests time out". The current statement is right that a process relays only its own `BULL_PREFIX`'s rows, but it names `OutboxRelay` only. It now names both relays (`app.outbox`, sends; `app.domain_events`, stored events), which both filter by prefix, in CLAUDE.md, the tutorial and modules.md. | Brief ("Remove stale statements (e.g. the outbox pitfall)"); `framework/api/src/channels/notify/outbox.relay.ts`, `framework/api/src/features/events/outbox-feed.ts`. |
| 8 | The tutorial's code follows the guide's own rules: a command decides who is on the team by capability (`can(p, …)`), never by a list of role names. | CLAUDE.md ("never a role name"); guide 6.4. |
| 9 | CLAUDE.md keeps every rule it has (agents rely on each), worded shorter, with section pointers into the guide for detail; it gains the module count, `docs/modules.md` and the commands it lacked. | Brief ("kept concise"). |
| 10 | `scripts/wt.sh` is documented in `docs/modules.md` as this repository's helper for one worktree, database and queue prefix per piece of work, since it is tracked and is the procedure parallel teams here follow. | Default: the parallel guide should name the tool the repository ships for it. |
| 11 | Plain style, as the rest of the guides: what the code does, the file or symbol that does it, no history of how it got there. | CLAUDE.md; H6 decision 5. |
| 12 | Fixit's entity becomes `repair` (module `repairs`, `complete-repair`, `/api/repairs`). The replay showed `defineServer` refusing the guide's `jobs` module: B11's long-running jobs reserve `/api/jobs` and own `app.jobs`. The guide says why, so a reader does not name a module after a framework feature. | Replay (decision 4); `reserveRoutes('jobs')` in `framework/api/src/features/jobs`. |
| 13 | Fixit's step 2 also removes `briefs` and the sample's `sql/post/orders-states.sql` (on a fresh database the hook fails without `app.orders`), keeps `account` (it words the credits and privacy notices) and `server/privacy.ts`, and its `server.ts` passes `languages`: without it the boot refuses every Hindi and Telugu word. Checked on a database migrated from nothing. | Replay (decision 4). |
| 14 | The two Fixit screenshots are removed: they showed the old entity, and taking new ones needs the Expo web app and a browser, which this unit does not run. The guide's text describes each screen instead. | Default: a picture of a tutorial that no longer builds misleads. |
| 15 | The guides' files are the files that were built: the Fixit files were extracted from the guide, formatted with Biome, built and tested, then written back into the guide's code blocks. The tutorial's snippets are trimmed excerpts of the replayed module (saved as a patch for the record, not committed). | Decision 4. |
| 16 | The developer guide's section 10 gains one short recipe per primitive the gaps added, grouped (modules and migrations; approvals and roles; records; documents, links and other systems; the assistant and the account), each pointing at its section. Sections 11 to 13 gain the rules and checks the gaps made true for every feature (capabilities, the boundary, money, module imports, migrations, settings writers, files, model runs; per-module runs, `lint:boundary`, the e2e checks). | Brief ("new primitives with short recipes, rules of the road, testing, definition of done"). |
| 17 | Section 14 gains two rows found while checking: SQL hooks are application-wide (nothing ties one to its module), and nothing in CI replays the tutorials. | Replay (decision 13); decision 4. |

## Assumptions to review

| Topic | Choice | Question for the product owner |
|---|---|---|
| Section 14's scope | Only what is missing; status rows ("Hooks that run", "Plugin slots in use") left it. | Is a list of what is wired where wanted somewhere (an architecture appendix), or is the code enough? |
| Replays on the workspace | The tutorials were replayed against the workspace packages, not the packed tarballs a new application installs. | Should a tutorial replay run in CI (a third job), so the guides cannot drift from the code again? |
| CLAUDE.md length | Kept every rule, shorter. | Should CLAUDE.md shrink to commands and pointers only, leaving every rule to the developer guide? |
| `scripts/wt.sh` in the guides | Documented as the repository's helper for parallel worktrees. | Is it part of the product (kept generic, with its base branch configurable), or tooling for this build only? |

## API sketch

None: documentation only.

## Test plan

- Each command in the changed files, run in the worktree (decision 3), with its result recorded
  below.
- The two tutorial replays (decision 4): build, typecheck, the tutorial's unit, e2e and eval runs.
- Every path, symbol, route and error code in new or changed text grepped in the merged tree.
- `pnpm lint`, `pnpm lint:deps`, `scripts/check-boundary.sh` and `scripts/wt.sh check HDOCS`.

### Results

| What | Result |
|---|---|
| Tutorial replay (`visits` in the sample, on a throwaway branch) | `basecamp module add visits --entity visit`, the tutorial's files, `pnpm db:generate --name site_visits` (`0009_site_visits.sql`), `pnpm db:migrate`; build and typecheck of `@application/api...` and `@application/mobile`; `pnpm lint:deps` clean; the view test; the 6 e2e tests; `basecamp eval --module visits` 4/4, `pnpm eval` 28/28, `eval voice` 15/15, `eval whatsapp` 14/14; the curl calls of step 3 and the `/api/chat/once` text result of step 4. With `visits` listed after `meetings` and an eval turn "show my visits", `defineServer` refused to start, naming `open-meeting`, as step 6 says |
| Fixit replay (`repairs` replacing the sample) | Step 2's deletions, the guide's files, `db generate` (`0000_repairs.sql`), build and typecheck (33 tasks), the server loads; on a database created empty and migrated from nothing: 4 e2e tests; `basecamp eval` 3/3, `eval whatsapp` 2/2 |
| `basecamp module add`, `db generate`, `db rebase` | Run on throwaway branches: two modules generated `0009_*` on two branches; the rebase auto-merged the four lists (union) and conflicted only under `drizzle/meta`; `git checkout --ours -- application/domain/drizzle`, then `basecamp db rebase --base <base>` regenerated `0010_*` on top; run again, it drops and regenerates the same |
| `basecamp eval --module nope` | Fails: `No module called nope (modules: …)`; a run with no cases fails `No cases ran` |
| `basecamp import todo …/todos.csv --as <email> --key legacy_id --source legacy --dry-run` | 5 rows, 5 created, nothing written (API with an inline worker and `STORAGE_DRIVER=fs` shared with the CLI) |
| `basecamp operator add` / `list` / `remove`, `basecamp --help` | As documented; Bull Board answered 200 to the operator |
| `pnpm templates:check` | Runs; the shared emulator had not been sent `credits_low_v1` and `credits_out_v1` (`templates:sync` was not run: it writes to the shared emulator) |
| CLAUDE.md's test commands | `framework/core` list-grammar unit test (5), `pnpm --filter @application/domain test` (12; 13 with the replayed visits test), the framework e2e `pages.e2e.test.ts` (9), the application e2e `todo.e2e.test.ts` (8), `fixture:generate` for `par` (no changes) |
| `cd application/api && pnpm vitest list test/domain/order --filesOnly` | The path filter modules.md documents selects the five order files |
| `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:deps`, `pnpm lint:boundary` | Pass |

### Not run here

`pnpm infra:up` / `infra:down`, `pnpm dev` and `basecamp dev`, `basecamp studio`, `basecamp start
worker` / `voice`, `pnpm templates:sync`, the golden WhatsApp conversations (whaloc-test reaches
the main checkout only), the native apps and Maestro, `pnpm --filter @application/mobile dev`,
`npm create @hykr/basecamp` from the registry (the CI `consumer` job packs and scaffolds), the
WhatsApp number claim, and the whole `pnpm test` (representative files were run; no code
changed).

### Found while checking (code, not changed here)

- `framework/create-basecamp/src/index.ts` (a comment) and `application/package.json`
  (`description`) still say the sample is meetings, notes and to-dos.
- The sample's `TodoDueNotification` fixes the time zone (already in section 14).

## Deferred

- New screenshots of Fixit (decision 14).
- A CI job that replays the tutorials (assumption "Replays on the workspace").
