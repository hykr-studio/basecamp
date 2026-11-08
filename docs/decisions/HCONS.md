# HCONS: the consumer job, the evals and the full CI

## Summary

A hardening unit. It reproduces the CI `consumer` job, runs every eval suite on the scripted
model, whole and per module, and runs the full CI sequence in its worktree, then fixes what
does not hold.

- **Consumer job.** The job as CI runs it (build `framework/*`, pack every package, scaffold
  with the packed `create-basecamp`, install from the tarballs, `pnpm -r build`,
  `pnpm -r typecheck`, `basecamp --help`) passes. Going further than CI, the scaffolded
  application was also migrated on an empty database, started, and answered all three eval
  suites from the tarballs. That run found one real defect: the published ranges let
  `better-auth` float past the version the OAuth plugin pins, so a new application gets two
  copies of Better Auth's core.
- **The job becomes one script.** `scripts/consumer.sh` is the job; CI calls it, so a local
  run is the same run. With `--run` it also migrates, starts and evaluates the scaffolded
  application. CI now runs it with `--run`: the evals were never in CI before.
- **Evals.** The whole suites passed. Per module, `eval --module briefs` failed because the
  module had no cases, and `eval voice|whatsapp --module` failed for every module except
  `todos`, because only `todos` had spoken cases. The briefs module now has scripts and
  cases, and notes, meetings, orders and briefs have spoken cases in English, Hindi and
  Telugu. Those cases also become each module's WhatsApp turns. `account` gives the
  assistant nothing, so it still fails by the framework's rule (no cases is not a pass), now
  with a message that says so.
- **Full CI** (install, lint, boundary, build, typecheck, lint:deps, migrate on an empty
  database, every test): results are under "What was run" below.

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | The consumer job is reproduced step for step: the same commands, the same overrides line built from the tarball names, in a directory outside the repository, so no workspace link or `.env` above it can help. | Brief (1); `.github/workflows/ci.yml`. |
| 2 | The reproduction goes past CI's last step. The scaffolded application runs `basecamp db migrate` on an empty database, then `basecamp start api`, then `basecamp eval`, `eval voice` and `eval whatsapp`. A build and a typecheck cannot catch a runtime import that only the workspace's hoisting satisfied, an SQL hook left out of `files`, or a dependency that drifted. Booting can. | Default: "the framework as a user gets it" means it runs, not only that it compiles. |
| 3 | `better-auth` is pinned to `1.7.7` in `@hykr/api` and `@hykr/app`, and so is `@better-auth/expo` in `@hykr/app`, the same version as `@better-auth/oauth-provider` (already pinned). The plugin pins its peers exactly (`better-call 1.4.0`, `@better-fetch/fetch 1.3.2`, `@better-auth/utils 0.4.2`). Under `^1.7.7`, a new application resolved `better-auth 1.7.18`, so it ran two `@better-auth/core` and two `better-call` copies: the MCP OAuth endpoints on one, the router on the other, a combination never tested. The workspace lockfile already resolves 1.7.7, so nothing changes in the repository's own install. | Consumer reproduction (`pnpm peers check` in the scaffolded app); default: when a plugin pins exact peers, the published ranges must not let the host move away from them. |
| 4 | `mastra 1.32.1` (Studio's UI) floats its `@mastra/deployer ^1.74.0` to a release that wants a newer `@mastra/core` (a peer warning). It is not pinned: the framework imports no `@mastra/deployer` code, and `basecamp studio` only runs the CLI's `studio` command, which serves the UI. Logged under Deferred. | Consumer reproduction; default: pin only what a test showed to matter. |
| 5 | `scripts/consumer.sh [--run] [--no-build] [<dir>]` holds the job. CI's `consumer` step calls it, so the local reproduction and CI cannot drift apart. `--run` needs Postgres (with `init.sql`) and Redis, plus the environment the `ci` job sets. It starts the API with `WORKER_INLINE=1` and memory storage: one process, the processors inside (memory recall needs the embedding worker), files shared between them. | Brief (1); default: one definition of the job. |
| 6 | The `consumer` job now gets the `ci` job's services (Postgres with PostGIS, Redis, Mailpit) and environment. The shared environment moves to the workflow's top-level `env` (one copy for both jobs). Its timeout goes from 25 to 35 minutes. | Default: the evals are not in CI anywhere, and a consumer app that compiles but cannot boot is the failure this job exists to catch. |
| 7 | The evals run in the `consumer` job, not in `ci`: there they also exercise the packed framework, and the `ci` job's 20-minute budget is already spent on `pnpm test`. The scaffolded application is a copy of `application/`, so these are the same cases. | Default (decision 6). |
| 8 | A module with no cases for a suite still fails that suite when it is named (`--module`). The framework's rule stays: nothing evaluated is not a pass. The message now names the module and what it lacks (`account has no eval cases (its agent part declares none): nothing was evaluated.`) instead of a bare "No cases ran". | Developer guide 5.11 and `docs/modules.md` section 6 ("fails on … one with no cases"); brief ("fail closed"). |
| 9 | `account` gets no eval cases. It has no entities, no commands and no agent part: it only words the framework's credit and privacy alerts. Any case written for it would test another module's tools or the help text. `basecamp eval --module account` fails, by decision 8. | Default; see the assumption below. |
| 10 | `briefs` gets scripts and cases. It has tools the assistant can call (`list-briefs`, `create-brief`, `update-brief`, `delete-brief`) and nothing checked them. Its verbs are its own (`new brief …`, `briefs`, `reviewed …`, `drop brief …`), because `todos`' `add …`, `delete …` and `list` come first in module order and the boot check refuses a script that takes another module's eval turn. | Definition of done ("Scripts for the fake model, and eval cases"; "`basecamp eval --module <name>` passes"); `scriptConflicts`. |
| 11 | notes, meetings, orders and briefs get spoken cases (`voiceEvalCases`) in English, Hindi and Telugu, with the scripts' replies in the turn's language and short enough to say. This makes `eval voice --module <m>` and `eval whatsapp --module <m>` (the non-English spoken cases, typed) pass for every module that gives the assistant tools. Titles and data stay as the person said them. | The developer guide's rule that every user-facing word is `Labels` in each of the application's languages; the PRD (Platform & AI: evals on golden datasets; voice in the person's language). |
| 12 | The scaffolder's banner and the template's `package.json` description name the six sample modules, not three. | Consumer reproduction (stale text in what a new user reads first). |
| 13 | The full CI sequence runs in the worktree, as `wt.sh ci` runs it in the main checkout, but on the worktree's own database dropped and created empty, not copied from `app_tpl`, with tests in one of the two machine-wide slots and `--continue`, so one run shows every failure. | Brief (3); `scripts/wt.sh ci`. |

## Assumptions to review

| Topic | Choice | Question for the product owner |
|---|---|---|
| A module the assistant cannot use | `basecamp eval --module account` fails ("nothing was evaluated"). | Should a module with no agent part and no tools be skipped as a pass instead, so a loop over every module can run unattended? |
| Evals in CI | The scripted-model evals run in the `consumer` job, against the scaffolded app. | Is about four more minutes per pull request acceptable, or should the evals run nightly instead? |
| Dependency ranges | `better-auth` and its Expo plugin are exact pins, the OAuth plugin's version. | Should the `@hykr/*` packages pin more of their runtime (Mastra, the AI SDK), or ship a lockfile-like `overrides` block in the scaffolded app, so a new application installs exactly what CI tested? |
| Spoken cases per module | Every module with tools has English, Hindi and Telugu spoken cases. | Should a module that is never used by voice be allowed to have none (and `eval voice --module` skip it)? |

## API sketch

```
scripts/consumer.sh [--run] [--no-build] [<work dir>]
  build framework/*, pack, scaffold <dir>/myapp, install from the tarballs,
  pnpm -r build, pnpm -r typecheck, basecamp --help
  --run: basecamp db migrate, basecamp start api (PORT, default 3000; WORKER_INLINE=1),
         basecamp eval, eval voice, eval whatsapp; stops the API on exit
  prints "::step <name>" per step, "::fail <name>" and exit 1 on a failure, "::ok" at the end
```

CI (`.github/workflows/ci.yml`, job `consumer`): the `ci` job's services, the workflow's shared
`env`, `init.sql`, then `scripts/consumer.sh --run "$RUNNER_TEMP/consumer"`.

## Test plan

- `scripts/consumer.sh --run` locally, on an empty database, after every change to package
  metadata: build, typecheck and boot pass, and the three suites pass on the tarballs.
- `pnpm peers check` in the scaffolded app: no second `@better-auth/core`.
- With the worktree's API on its own port: `basecamp eval`, `eval voice` and `eval whatsapp`,
  whole and `--module` for each of the six modules. Each passes, except `account`, which fails
  with the new message.
- `defineServer`'s boot check (`scriptConflicts`) and the domain's unit tests still pass with
  the new scripts.
- The full CI sequence in the worktree (decision 13).

## What was run

Filled in as the runs finish:

- Consumer job, as CI runs it, before any change: passed.
- Scaffolded app, migrated, started, evaluated, before any change: assistant 24/24, voice
  15/15, WhatsApp 14/14.
- Per-module evals before any change: assistant `briefs` and `account` failed (no cases); voice
  and WhatsApp failed for every module but `todos`.

## Deferred

- `@mastra/deployer` and `@opentelemetry/api` drift in a new application (peer warnings,
  decision 4). Nothing failed in the boot, eval or Studio checks; they are not pinned.
- The GitHub workflow itself is checked here only by running the same script and commands
  locally. The first pull request run is the first real run of the new `consumer` steps.
