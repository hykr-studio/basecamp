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

## Deferred

- Nothing yet.
