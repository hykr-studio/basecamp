# HCONS: the consumer job, the evals and the full CI

## Summary

A hardening unit. It reproduces the CI `consumer` job, runs every eval suite on the scripted
model, whole and per module, and runs the full CI sequence in its worktree, then fixes what
does not hold.

- **Consumer job.** The job as CI runs it passes: build `framework/*`, pack every package,
  scaffold with the packed `create-basecamp`, install from the tarballs, `pnpm -r build`,
  `pnpm -r typecheck`, `basecamp --help`. This unit went further than CI. The scaffolded
  application was also migrated on an empty database, started, and answered all three eval
  suites from the tarballs, and its Studio started. That run found one real defect. The
  published ranges let `better-auth` float past the version its OAuth plugin pins, so a new
  application got two copies of Better Auth's core. It is now pinned.
- **The job becomes one script.** `scripts/consumer.sh` is the job, and CI calls it, so a local
  run is the same run. With `--run` it also migrates, starts and evaluates the scaffolded
  application. CI now runs it with `--run`. The evals had never run in CI before.
- **Evals.** The whole suites passed. Per module, `eval --module briefs` failed because the
  module had no cases. `eval voice|whatsapp --module` failed for every module except `todos`,
  because only `todos` had spoken cases. The briefs module now has scripts and cases, and
  notes, meetings, orders and briefs have spoken cases in English, Hindi and Telugu. Those
  cases also become each module's WhatsApp turns. Writing the briefs cases exposed a gap: the
  assistant cannot create a record that carries money unless the person names the currency
  (decision 12). `account` gives the assistant nothing, so by the framework's rule it still
  fails (no cases is not a pass). Its message now says so.
- **Full CI.** Install, lint, boundary, build, typecheck, lint:deps, migrate on an empty
  database, and every test pass, before and after this unit's changes ("What was run").

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | The consumer job is reproduced step for step: the same commands and the same overrides lines built from the tarball names. It runs in a directory outside the repository, so no workspace link and no `.env` above it can help. It runs with `CI=true`, as on GitHub, where pnpm defaults to a frozen lockfile. | Brief (1); `.github/workflows/ci.yml`. |
| 2 | The reproduction goes past CI's last step. The scaffolded application runs `basecamp db migrate` on an empty database, then `basecamp start api`, `basecamp eval`, `eval voice`, `eval whatsapp` and `basecamp studio`. A build and a typecheck cannot catch a runtime import that only the workspace's hoisting satisfied, an SQL hook left out of `files`, or a dependency that drifted. Booting can. | Default: "the framework as a user gets it" means it runs, not only that it compiles. |
| 3 | `better-auth` is pinned to `1.7.7` in `@hykr/api` and `@hykr/app`, and `@better-auth/expo` to `1.7.7` in `@hykr/app`. That is the version of `@better-auth/oauth-provider`, which was already pinned. The plugin pins its peers exactly (`better-call 1.4.0`, `@better-fetch/fetch 1.3.2`, `@better-auth/utils 0.4.2`). Under `^1.7.7`, a new application resolved `better-auth 1.7.18` and so ran two `@better-auth/core` and two `better-call` copies: the MCP OAuth endpoints on one, the router on the other, a combination never tested. After the pin it gets one of each. The workspace lockfile already resolved 1.7.7, so only the specifiers change. | Consumer reproduction (`pnpm peers check` and `node_modules/.pnpm` in the scaffolded app); default: when a plugin pins exact peers, the published ranges must not let the host move away from them. |
| 4 | `mastra 1.32.1` (Studio's UI) floats `@mastra/deployer ^1.74.0` to a release that wants a newer `@mastra/core`, and OpenTelemetry's API floats past its SDK's peer range. Both only print peer warnings. Neither is pinned. The framework imports no `@mastra/deployer` code. In the scaffolded app, `basecamp studio` served the UI on 4000 and the Mastra server on 4111 (both answered 200). | Consumer reproduction; default: pin only what a check showed to matter. |
| 5 | `scripts/consumer.sh [--run] [--no-build] [<dir>]` holds the job, and CI's `consumer` step calls it, so the local reproduction and CI cannot drift apart. `--run` needs Postgres (with `init.sql`), Redis and the environment the `ci` job sets. It starts the API with `WORKER_INLINE=1` and memory storage: one process with the processors inside (memory recall needs the embedding worker) and the files they share. The API's own pid is the one stopped on exit, because both the subshell and the bin shim `exec`. | Brief (1); default: one definition of the job. |
| 6 | The `consumer` job now gets the `ci` job's services (Postgres with PostGIS, Redis, Mailpit) and its environment. The shared environment moves to the workflow's top-level `env`, one copy for both jobs. The timeout goes from 25 to 35 minutes. | Default: no job ran the evals, and a consumer app that compiles but cannot boot is the failure this job exists to catch. |
| 7 | The evals run in the `consumer` job, not in `ci`. There they also exercise the packed framework, and `pnpm test` already takes most of the `ci` job's 20 minutes. The scaffolded application is a copy of `application/`, so these are the same cases. | Default (decision 6). |
| 8 | A module with no cases for a suite still fails that suite when it is named (`--module`). The framework's rule stays: nothing evaluated is not a pass. The message now names the module and the `AgentModule` field it lacks, e.g. `account has no eval cases (agent.evalCases): nothing was evaluated.`, instead of a bare "No cases ran". | Developer guide 5.11 and `docs/modules.md` section 6 ("fails on … one with no cases"); brief ("fail closed"). |
| 9 | `account` gets no eval cases. It has no entities, no commands and no agent part: it only words the framework's credit and privacy alerts. Any case written for it would test another module's tools or the help text. `basecamp eval --module account` fails, by decision 8. | Default; see the assumption below. |
| 10 | `briefs` gets scripts and cases. The assistant can call its tools (`list-briefs`, `create-brief`, `update-brief`, `delete-brief`), and nothing checked them. Its verbs are its own (`new brief …`, `list briefs`, `new briefs`, `mark brief … reviewed`, `drop brief …`). The `todos` module's `add …`, `delete …` and `list` come first in module order, and the boot check refuses a script that takes another module's eval turn. | Definition of done ("Scripts for the fake model, and eval cases"; "`basecamp eval --module <name>` passes"); `scriptConflicts`. |
| 11 | notes, meetings, orders and briefs get spoken cases (`voiceEvalCases`) in English, Hindi and Telugu. Their scripts answer in the turn's language, and in one line when spoken: meetings' `today` says the counts and leaves the lists to the screen. Titles and data stay as the person said them; where a reply names one, it is quoted, so it does not count against the reply's language. The cases a typed turn cannot match the same way (no canvas on WhatsApp) expect the lookup, not where the record opens. Every module with tools now passes `eval voice --module <m>` and `eval whatsapp --module <m>`. The orders cases get an `evalSetup`: the business counts in INR (the money settings section, through its writer) and has one saved order, "Eval kitchen", for the lists and totals to find. | The developer guide's rule that every user-facing word is `Labels` in each of the application's languages; PRD Platform & AI (evals on golden datasets). |
| 12 | A brief carries a currency, and a plain create of an entity with the `money` trait must name one: the framework does not take the business's (`currency_required`, decisions B3B5, decision 3). The assistant cannot see the business's currency, so the briefs evals name it with the budget ("new brief Asha: a bookshelf for the study, budget 20000 INR"). One case checks that a brief named without a currency is refused and that the assistant says so instead of picking one. The framework is not changed here. The gap is in section 14 of the developer guide and in the assumptions below. | Found by the new briefs evals; brief ("fail closed", "never stop to ask"); not this unit's code (B3B5's plugin). |
| 13 | The scaffolder's header comment and the template's `package.json` description name the six sample modules, not three. | Consumer reproduction (stale text in what a new user reads first). |
| 14 | The full CI sequence runs in the worktree as `wt.sh ci` runs it in the main checkout, with three differences. The worktree's own database is dropped and created empty, not copied from `app_tpl`. The tests run in one of the two machine-wide slots. `--continue` lets one run show every failure. | Brief (3); `scripts/wt.sh ci`. |

## Assumptions to review

| Topic | Choice | Question for the product owner |
|---|---|---|
| A currency for the assistant's creates | A plain create of a record with money must name its currency. The assistant cannot see the business's currency, so the person must say it (the sample's briefs evals do). | Should a create that names no currency take the business's currency (its `money` settings, then `DEFAULT_CURRENCY`), and refuse only when there is neither? Or should the assistant be told the business's currency in its instructions? |
| A module the assistant cannot use | `basecamp eval --module account` fails ("nothing was evaluated"). | Should a module with no agent part and no tools be skipped as a pass instead, so a loop over every module can run unattended? |
| Evals in CI | The scripted-model evals run in the `consumer` job, against the scaffolded app. | Is about four more minutes per pull request acceptable, or should the evals run nightly instead? |
| Dependency ranges | `better-auth` and its Expo plugin are exact pins, at the OAuth plugin's version. Everything else keeps its range. | Should the `@hykr/*` packages pin more of their runtime (Mastra, the AI SDK, OpenTelemetry), or should the scaffolder write an `overrides` block, so a new application installs exactly what CI tested? |
| Spoken cases per module | Every module with tools has English, Hindi and Telugu spoken cases. | Should a module nobody uses by voice be allowed to have none, with `eval voice --module` skipping it? |

## API sketch

```
scripts/consumer.sh [--run] [--no-build] [<work dir>]
  build framework/*, pack, scaffold <dir>/myapp, install from the tarballs,
  pnpm -r build, pnpm -r typecheck, basecamp --help
  --run: basecamp db migrate, basecamp start api (PORT, default 3000; WORKER_INLINE=1,
         STORAGE_DRIVER=memory, MODEL_MODE=fake), basecamp eval, eval voice, eval whatsapp;
         the API stops when the script exits
  prints "::step <name>" per step, "::fail <name>" and exit 1 on a failure, "::ok" at the end
```

CI (`.github/workflows/ci.yml`, job `consumer`): the `ci` job's services, the workflow's shared
`env`, `init.sql`, then `scripts/consumer.sh --run "$RUNNER_TEMP/consumer"`.

`@hykr/agents/evals`: `report(rows, nothing?)` and `nothingRan(module, kind)`, which words why
nothing ran.

## Test plan

- `scripts/consumer.sh --run` locally, with `CI=true`, on an empty database: build, typecheck,
  boot and the three suites pass on the tarballs.
- In the scaffolded app, `pnpm peers check` and `node_modules/.pnpm` show one
  `@better-auth/core` and one `better-call`, and `basecamp studio` answers on 4000 and 4111.
- Against the worktree's API on its own port, database and queue prefix: `basecamp eval`,
  `eval voice` and `eval whatsapp`, whole and `--module` for each of the six modules. Each
  passes except `account`, which fails with the new message.
- `defineServer`'s boot check (`scriptConflicts`) runs in every application e2e boot. The
  domain's unit tests and the application's e2e tests (golden files of the scripted model
  among them) still pass.
- The full CI sequence in the worktree (decision 14).

## What was run

- Consumer job, as CI runs it, before any change: passed.
- Scaffolded app, migrated, started and evaluated, before any change: assistant 24/24, voice
  15/15, WhatsApp 14/14. `pnpm peers check`: `better-auth 1.7.18` with two
  `@better-auth/core` copies.
- Per-module evals before any change: assistant failed for `briefs` and `account` (no cases);
  voice and WhatsApp failed for every module but `todos`.
- Full CI in the worktree at the base (`090fd9f3`): passed. Framework e2e 71 files and 1168
  tests, application e2e 28 files and 166 tests (golden WhatsApp skipped: no whaloc-test here),
  every unit suite.
- After the changes, against the worktree's API: assistant 33/33, voice 39/39, WhatsApp 30/30.
  Per module, every suite passes for todos, notes, meetings, orders and briefs; `account`
  fails all three with "account has no … : nothing was evaluated."
- `scripts/consumer.sh --run` with `CI=true`, after the changes: passed. The scaffolded app
  migrated, started, and passed assistant 33/33, voice 39/39, WhatsApp 30/30, with one
  `@better-auth/core` (1.7.7) and one `better-call` (1.4.0). Studio served its UI on 4000 and
  its server on 4111.
- Full CI in the worktree after the changes: see the unit's final report (the run is the last
  step).

A note for whoever runs builds in parallel: a source edit made while a turbo run is building
is compiled into an output stored under the hash of the sources from before the edit. The
cache directory is shared between worktrees (`wt.sh`), so another checkout with the old
sources would then restore the new output. It happened once here, to the domain's build
during the baseline run. The two entries it wrote were deleted from the shared cache.

## Deferred

- The assistant's creates of money records without a currency (decision 12): a framework
  change, for the owner to decide (assumptions).
- `@mastra/deployer` and `@opentelemetry/api` drift in a new application (peer warnings,
  decision 4).
- The GitHub workflow itself is checked here only by running the same script and commands
  locally. The first pull request run is the first real run of the new `consumer` steps.
