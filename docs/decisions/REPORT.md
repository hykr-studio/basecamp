# REPORT: the assumptions register and the run report

## Summary

The last unit of the platform-gaps run. It writes `docs/decisions/README.md`, the register the
product owner reviews:

- an index of every decisions doc in this folder, with the gaps each one covers;
- one table of every assumption the units made, across all of them, with what was chosen, where
  the choice came from and the question for the owner, duplicates merged;
- a run report: which units merged into `feat/platform-gaps`, which did not and why, and the
  known gaps each unit left open.

The root `README.md` and `CLAUDE.md` now point to it. No code changes.

The register has 484 rows: 458 items of the units' "Assumptions to review" sections and 70
assumptions the units reported that their docs do not state, less 33 merged into other rows and
11 process notes. All 50 earlier units merged; none was blocked.

## Decisions

1. **What counts as an assumption.** Every item of each doc's "Assumptions to review" section,
   plus every assumption a unit reported to the workflow (the reports of the earlier runs, and
   this run's) that its doc does not already state. Source: the task note ("read every
   decisions doc; don't rely only on these lists").
2. **What is left out of the table.** Notes about the build process rather than the product:
   merging the integration branch into a unit's branch, which test approach a fix round took,
   where a sample demo lived before its module existed, and fix-round internals with no question
   and nothing a person sees (retry bookkeeping, NUL stripping, the shape of an error body). They
   stay in the units' decisions docs. Source: default; the register is for the product owner,
   and the integrator already acted on the process notes.
3. **Merging duplicates.** One row per question. When several units raise the same question
   (the 10-second settings cache, unverified emails, how long acceptance evidence is kept, fonts
   for other scripts, the privacy contact, a working week when a business sets none), the row
   names every unit and keeps the latest answer. Source: task note ("merge duplicates").
4. **Answered later.** An assumption a later unit settled stays in the table, merged with the
   unit that settled it, and says so in its question column ("Settled by H1"), so the owner can
   see the decision moved. Source: default; deleting it would hide that a choice was made.
5. **Source column.** One of PRD (with its tab and section), gap list (the gap statement, or the
   gap map's risks and owner questions), plan (the approved plan, including the boundary rule
   and the hot-file table), a review finding, or default (a conservative choice by the unit, fail
   closed where access is concerned). Taken from what the unit reported when it reported one,
   otherwise from the doc's own text. Source: task note (the column's values).
6. **No question stated.** An item a unit listed for review without asking anything says
   "Confirm" in the question column; a reported assumption with no question says "None".
   Source: default.
7. **Known gaps.** The run report lists, per unit, the known gaps it reported that are still
   open on `feat/platform-gaps` after every merge. Items that the integration closed are
   dropped: local WIP migrations (the integrator generated each unit's migration at merge),
   "not merged with the latest base" notes, "suites not re-run" notes (HCONS ran the full CI on
   the merged branch) and the hot-file deviations the integrator merged. Items a later unit
   fixed name that unit. Units that reported no known gaps point to their doc's Deferred section
   and to developer guide section 14, which is the maintained list. Source: task note ("the
   remaining knownGaps per unit").
8. **Where it lives.** `docs/decisions/README.md`, beside the docs it indexes, so GitHub shows it
   when the folder is opened and the draft pull request can link to it. Source: plan (phase 5,
   Report).
9. **Built from the docs by a script, then edited.** The table's rows were extracted from each
   doc's "Assumptions to review" section (bold lead as the topic, statements as the choice,
   questions as the question), matched to the units' reports for their sources, then merged and
   corrected by hand. The script is not committed: the register is a document, not a build
   output. Source: default.

## Assumptions to review

- **The register is a snapshot.** It reflects the decisions docs as merged at `10b54eae`
  (HCONS). A later change to a unit's doc does not update it. Should the register be regenerated
  by a script in CI instead of kept by hand?
- **Process notes are left out** (decision 2). Should the owner also see them, for example the
  two hot-file deviations the integrator merged (A1 in `auth.ts`, A4 in `define-entity.ts`)?

## API sketch

None. One Markdown file, `docs/decisions/README.md`, and this doc.

## Test plan

- Every `docs/decisions/<ID>.md` appears in the index, and every item of every unit's
  "Assumptions to review" section appears in the table, on its own row or merged into another.
- Every merge commit on `feat/platform-gaps` has its unit in the run report.
- `scripts/check-boundary.sh` and `wt.sh check REPORT` pass (no code, no migrations).
- `pnpm lint` passes (Biome does not read Markdown; the run checks nothing else changed).

## Deferred

- Regenerating the register automatically from the decisions docs.
- The owner's answers: the register has no column for them. The owner answers on the pull
  request, or in each unit's doc, whose "Assumptions to review" section the next unit updates.
