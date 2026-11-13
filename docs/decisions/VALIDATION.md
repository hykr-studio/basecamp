# VALIDATION: the platform gaps in a running deployment

The run report ([README](README.md#run-report)) left the gaps checked by tests only: no unit had
driven them in a running deployment. This pass did, on 2026-11-12 and 13, at `23805b76`. Nothing
in the code changed.

## What was run

| Check | Result |
|---|---|
| Full CI (`scripts/wt.sh ci --full`, fresh database) | Passed: lint, boundary, build, typecheck, lint:deps, migrate; framework e2e 71 files, 1,169 tests; application e2e 29 files, 178 tests; 36 of 36 turbo tasks |
| Scripted evals against a live API | Assistant 33/33, voice 39/39, WhatsApp 30/30 |
| Consumer job (`scripts/consumer.sh --run`, its own database and port) | Passed: packed, scaffolded, built, typechecked, migrated; evals 33/33, 39/39, 30/30 |
| `templates:check` | Every template a notification uses is approved |
| Live validation (10 validators, then one independent verifier per defect) | 349 claims: 282 work, 18 defects, 8 documented gaps, 41 not testable here |

The live validation drove the API and worker (compiled, `MODEL_MODE=fake`, S3 on MinIO, Mailpit,
whaloc, the fake Google) on a database of its own (`app_val`), as people and businesses it made.
Each validator tried to break its gaps' claims: another business's record, a member without the
capability, a contact, a participant, a guest, the assistant acting for someone, repeats with one
idempotency key. Every defect was then reproduced by a second agent, which read the code for the
root cause and checked it against the decisions docs and developer guide section 14.

The five smoke flows the run report left open all work end to end: an order from lines to an OTP
acceptance of a frozen v1 (C3), a parked assistant run that resumes in its thread (C2), an MCP
client's OAuth handshake with PKCE, refresh and revocation (C6), a credit cap alerting at 80% and
pausing at 100%, then resuming after a top-up (C5), and push falling back to WhatsApp and email
(C7).

## Defects, by root cause

Severity is the verifier's. Ids are the validators' (`C<cluster>-<n>`).

| # | Root cause | Ids | Severity |
|---|---|---|---|
| 1 | **Prototype pollution in the list query string.** `nestBrackets` (`framework/contracts/src/framework/list.ts:313`) writes `?__proto__[x]=1` onto `Object.prototype`. One signed-in person's request breaks every list and summary route, sign-up and `/api/me`, for every business, until the process restarts. It predates this branch: `main` has the same code since `59bcb62f`. | C10-1 | Critical |
| 2 | **Cross-business references through plain foreign keys.** A to-do's or note's `meetingId` accepts another business's meeting (201), and an unknown id is a bare 500, so the answer tells whether an id exists anywhere. The other business's delete then nulls this business's rows through `ON DELETE SET NULL`, with no audit row. Only `traits.parent` checks a reference against the caller's business; `tableRef` exposes `id` alone. | C1-1, C8-1, C1-2 | Medium |
| 3 | **Erasure leaves copies.** The erased person's file names stay in `file.*` audit rows; their email stays in `app.member_invites`, the invite audit rows and a calendar connection's audit label (the business still lists it under invitations); their chat words stay in Mastra's scorer and observability tables. | C8-2, C8-3, C8-4 | Medium |
| 4 | **An unknown currency code is accepted.** Any three capital letters pass (`ABC`); its exponent is guessed as 2, and an order spends a series number. Only settings check the code against ISO 4217. | C3-1 | Medium |
| 5 | **A refused marketing send uses up the contact's weekly marketing cap.** The cap counts failed rows, so after a credits pause the resend is dropped. | C5-6 | Medium |
| 6 | **Integrations management ignores the idempotency key.** A retried endpoint or connection create makes a second one with its own secret. | C9-1 | Medium |
| 7 | A tampered list cursor whose value does not fit the sort field's type is a 500 (no leak; the query is parameterised). | C10-2 | Low |
| 8 | Credits: `GET /api/credits` says `paused: null` while a meter limit refuses every turn; `alertAt` may equal `pauseAt`; a member without `credits.manage` gets 503 instead of 403 on a purchase; the embedding-limit notice says the assistant is paused. | C5-3, C5-1, C5-2, C5-4 | Low |
| 9 | MCP and agents: the consent screen cannot narrow a scope from change to read; `?lang` does not choose the OAuth pages' language; a revoked or expired token is told a token is needed; `x-channel: webmcp` does not stop writes on Better Auth routes; an event agent runs on an event that happened before it existed. | C6-4, C6-3, C6-5, C6-2, C6-1 | Low |
| 10 | Words and channels: the waiting line asks the requester to approve what someone else decides; a WhatsApp reply links `/approvals` without the id; a WhatsApp list's heading is its first item when the view has no title; with a flag off the scripted model says "the API answered undefined"; masked push tokens all read `ExponentPushToken[…`. | C2-2, C2-3, C7-2, C9-2, C7-1 | Low |

None of them is in "Known gaps still open" or guide section 14. Full detail per defect (repro,
root cause with file and line, fix sketch) is in the evidence folder below, `val/confirmed.md`.

## Fixes

Thirteen units fixed the defects, on 2026-11-13, each on its own branch (`gap/V<n>`) with its
decisions doc (`V1.md` to `V13.md`), reviewed with fix rounds until no blocking finding was left
(V8, V10 and V11 took three reviews), and CI on a fresh database before its merge. Each merged
into `feat/platform-gaps` as a merge commit, in the order the reviews finished: V2, V3, V1, V5,
V4, V6, V7, V9, V8, V11, V10, V12, V13. The integrator generated the two migrations (`2db3cd2e`
for V2, `37c1370a` for V6) and made two integration commits (`31a3c908` after V10, `f63bb019`
after V13). The head is `f63bb019`. At `a0865ebd` the consumer job passed (`scripts/consumer.sh
--run` on its own database and port: packed, scaffolded, built, typechecked, migrated; evals 33
of 33, 39 of 39, 30 of 30), and at `f63bb019` the full CI (fresh database; 15 packages, 208 test
files, 2,263 tests, 36 of 36 turbo tasks; its first attempt at `a0865ebd` failed the one test
`f63bb019` fixes).

Nine units took the ten root causes above. Four more (V10 to V13) took what their reviews and
the acceptance runs found, below. What holds now is what the final acceptance run saw on
`a0865ebd`, the branch's head before the last test-only commit.

| # | Root cause | Units | Merged as | What holds now |
|---|---|---|---|---|
| 1 | Prototype pollution in the list query string | V1; V10 for the same class | `781b71fb`; `d790b5fb` | Every prototype-named query key on a list, a summary or the custom-filter check is refused for its sender alone (400); prototype-named body keys and route parameters are dropped or refused and never stored. A fuzz of 2,244 malformed requests as a member answered no 5xx and leaked nothing of the other business, whose lists, writes and sign-up stayed healthy; the API's process never restarted. |
| 2 | Cross-business references through plain foreign keys | V2 (`traits.references`, the composite key); V10 for `reviseWithChildren`, a form's answer and undo | `1ac04453` (migration `2db3cd2e`); `d790b5fb` | Another business's meeting, an unknown id and, for staff, a meeting the writer cannot read all answer 404 with the same body, nothing stored, through the app's API, the assistant, POST and PATCH. An import reports both cases as `unknown_reference` on the field. Undoing a delete whose meeting is gone is the reference's 404. A business deleting its own meeting nulls only its own rows. |
| 3 | Erasure leaves copies | V3 (files, invitations, the calendar label, Mastra's scores, deep redaction); V8 (every other feature's copies, Redis's finished jobs, briefs) | `5a2456ce`; `38fe9cf3` | After a member's own erasure and a contact's team-filed erasure, a sweep of every table of every schema and every Redis key under the run's prefix finds no copy outside what the decisions keep: audit rows, stored events, inbox items, kept replies, agent runs, parties, share links, push tickets, Mastra's tables, briefs, the outbox, messages and Redis all read "after 0". The same after erasures filed from WhatsApp. |
| 4 | An unknown currency code is accepted | V4; V10 for an order already stored in one | `aae893d7`; `d790b5fb` | `ABC` is refused 403 `money_invalid` on a plain create and on the order save; an order stored in `ABC` before the fix is refused in `authorize`, so the owner's save with no line writes nothing and the assistant's save does not park. Summaries sum money per currency. |
| 5 | A refused marketing send uses up the weekly cap | V5 | `22132282` | A send a credits pause refused leaves the cap; the resend after the top-up goes, and a fresh contact gets the send (the control). |
| 6 | Integrations management ignores the idempotency key | V6 (with the calendar, files, jobs and back-office routes, and two more root causes: an event reaching a subscriber made after it, one poison stored event stopping every business's events); V11 for concurrent repeats | `ef225d80` (migration `37c1370a`); `99f87fc7` | A retried endpoint or connection create with one key is one row and one secret; the calendar, files and job-cancel routes answer their first answer again; two cancels or two calendar completes sent at once with one key get the same answer on one connection. An event that happened before an endpoint or an agent existed does not reach it (C6-1). |
| 7 | A tampered list cursor is a 500 | V1; V10 for the inbox, comments, agent-run and SLA cursors; V12 for what the walks found | `781b71fb`; `d790b5fb`; `d2844401` | A tampered cursor on nine entity and sort cases (date, text, timestamp, geo, money, integer) is 400 `bad_cursor`, and so are far-off times and NUL ids on the inbox, comments, agent-run and SLA cursors (18 cases) and a garbage agent-runs cursor. Genuine cursors page. Thirty-seven keyset walks at limit 1 over every sort of to-dos, notes, meetings, orders and order items return every row once, ascending timestamp walks and a descending walk after same-transaction imports included. |
| 8 | Credits: `paused: null` under a meter limit, `alertAt` at `pauseAt`, 503 for 403, the embedding notice | V5; V11 for the operator's plan; V13 for the words | `22132282`; `99f87fc7`; `a0865ebd` | A reached `tokens` or `tool_calls` limit reads `paused` with its rule to the owner, to staff (without amounts) and to the operator, and turns are 402; a reached embedding limit leaves `paused` null while its meter carries the refusal. `alertAt` at or above `pauseAt` is refused for the business, for the operator's plan as it will be stored, and at start for the defaults. Staff get 403 on a purchase. A limit's notice says what stopped and never that the assistant is paused. |
| 9 | MCP and agents | V9 (the consent screen, `?lang`, the token's reason, `x-channel` on Better Auth's routes); V6 for C6-1; V11 for where `lang` goes | `217e12cc`; `ef225d80`; `99f87fc7` | The consent screen offers not allowed, read or change per module; `?lang` picks the pages' language and is carried to the consent page only, never to a client's `redirect_uri`; a revoked or expired token is told so; `x-channel: webmcp` reaches nothing on `/api/auth` and the other credentials (an MCP token, the agent key, a run's headers, a guest's share session) sign nothing there. Eighteen lead checks passed: redirect shapes, a credential made before a demotion or removal, MCP under the operator's pause, and the rate limits below. |
| 10 | Words and channels | V7; V11 for rule reasons; V13 for the lookup shown as the answer | `43bee58c`; `99f87fc7`; `a0865ebd` | The waiting line names who decides, in English, Hindi and Telugu, in the app and on WhatsApp, where "approve it in the app" links `/approvals/<id>`; a WhatsApp list is headed by its title; with a flag off the scripted model says "I can't do that here." in every language and calls no tool; masked push tokens tell devices apart; no rule's reason says whose approval it is. |

**After the reviews and acceptance.** The reviews approved the first nine units and left
findings of the same classes, and the first acceptance run found three more defects. Four units
took them:

- **V10** (`d790b5fb`, with `31a3c908`), from the reviews of V1, V2 and V4: a NUL character in
  any text that reached Postgres was a 500 (lists, summaries, writes, feature routes, Better
  Auth's `update-user`), now 400 `nul_character` at the request edge, in a custom filter's JSON,
  in a query past the parser's 1,000 keys, and in an import file (its row alone fails); the
  inbox, comments, agent-run and SLA cursors took any time or id; three writes skipped the
  reference check (`reviseWithChildren`, a public form's answer, undo); an order stored in a
  made-up currency could never be saved; the server started without ICU's currencies; times
  Postgres cannot store (the year 0000, `99999`) on the SLA cursor, history, the routing log,
  credits usage, the operator's usage report and a list's date filter, with an offset included
  (`31a3c908`); a filter value its column cannot hold, checked against Postgres itself; half a
  surrogate pair; an SLA `within` of any size.
- **V11** (`99f87fc7`), from the reviews of V5, V6, V7 and V9: `TRUST_PROXY`; a client's own
  `x-hykr-client-address` replaced everywhere; a subscriber's or notification's throwing filter
  loses that event alone; the routes with their own reply run one at a time per caller and key
  (`oneAtATime`); a meter reports only a refusal that happens and a limit that stops nothing
  raises no level; the operator's plan is checked as it will be stored; a named approver who left
  the team gives way to the holders of `approvals.decide`, and so does a requester outside it; a
  replay that no longer validates ends as failed, once; nothing inside a write's transaction
  reaches the pool (a job's input files, a comment's mentions, a write's metering), shown by the
  whole suite running with every pool at one connection; an empty patch is 400
  `nothing_to_change`; what became of a request reads in every language.
- **V12** (`d2844401`), from the first acceptance run: a list sorted by a timestamp kept the
  boundary row's time in its cursor to the millisecond while Postgres stores microseconds, so an
  ascending walk at limit 1 never advanced (the to-dos' default sort) and a descending walk
  skipped the rows of one transaction (12 of 17 to-dos after two imports). Older than the branch.
  Every keyset in the framework now selects its time key as text to the microsecond and compares
  it in SQL; the credits ledger, the delivery log and the routing log page by (time, id).
- **V13** (`a0865ebd`), from the first acceptance run: a lookup the assistant made before a
  write was shown as the answer ("No orders." after the waiting line, on every channel); a meter
  limit's refusal named the internal meter (`tool_calls`), now its label in the reader's language;
  one use past a limit sent "low" (at 3000%) together with "limit reached", now one alert per
  crossing and a budget share of at most 100%.
- `f63bb019`, the last commit: the models policy e2e test no longer assumes an order between the
  two audit rows one write makes in one transaction (B18's known gap).

### Deviations from the user's choices

The user chose "existing cross-business rows nulled through the write path". V2 nulls them in
an idempotent SQL hook instead (`application/domain/sql/post/meeting-references.sql`, run on
every migrate before it adds the composite keys): the links should never have been stored, and a
hook cannot go through `runWrite`. So the repaired to-dos and notes get no audit row and no
version bump, and a business that relied on such a link loses it silently (V2 decision 11 and
its first assumption). The user accepted this on 2026-11-13. On `app_val` the hook repaired 4
to-dos and 1 note: three to-dos and the note of one business named one meeting of another, and
a fourth to-do another pair (recorded before the migrate at 06:35:08Z, with the five rows null
and both keys present after it; `scratchpad/val/v2-repair-before.txt`, copied to the session
folder as `fix/v2-repair-before.txt`).

### The acceptance runs

Six suites, one per group of fixes, drove the API and worker on `app_val` as people and
businesses they made, the way the validators had: each check records what was expected and what
was observed, and each suite also re-drives the "works" claims of its area (no regression was
found in either run), runs its smoke flows, and follows leads.

| Group | Covers | First run (`217e12cc`) | Final run (`a0865ebd`) |
|---|---|---|---|
| g0 | C10, V1, V10 (NUL, cursors, imports), V12 | 70 of 103, smoke 37 of 37 | 103 of 103, smoke 37 of 37, leads 11 of 11 |
| g1 | references, currency, idempotency, events (V2, V4, V6, V10, V11) | 73 of 78, smoke 5 of 5, leads 4 of 4 | 78 of 78 (twice: a rerun alone re-checked the presign race), smoke 5 of 5, leads 4 of 4 |
| g2 | words and channels, credits (V5, V7, V11, V13) | 36 of 38, smoke 12 of 12 | 38 of 38, smoke 12 of 12 |
| g3 | MCP, the OAuth pages, Better Auth (V9, V11) | 29 of 30, smoke 5 of 5, leads 18 of 18 | 30 of 30, smoke 5 of 5, leads 18 of 18 |
| g4 | erasure (V3, V8) | 15 of 30, smoke 14 of 14 | 30 of 30, smoke 14 of 14, leads 4 of 4 |
| g5 | WhatsApp intake and the document send (B18, C3, V8) | 18 of 18, smoke 7 of 7 | 18 of 18, smoke 7 of 7, leads 4 of 4 |

The first run was on `217e12cc`, with V1 to V7 and V9 merged, V8 held for review and V10 and
V11 in review. Every one of its 56 failing checks was a check written for one of those three
units, or the credits usage report's far-off range, which V10 then took; the checks for the
merged units all passed. Its leads found what became V12 (two paging walks in g0, failing) and
V13 (the three wording problems in g2), and the erasure residue in business A and in Redis that
V8 was to close (g4, g5). The final run, on `a0865ebd` checked out apart (`basecamp-wt/ACC`,
`app_val` migrated and its templates synced, 15 approved), ran g0 alone, g1 to g4 together, then
g5 alone: every check passes, none went from pass to fail, and everything the first run deferred
holds. g2's three wording leads are not counted (the suite records them as observations): the
replies and reasons were read, and none of the three appears.

The smoke flows: an order from lines to an OTP acceptance of a frozen v1 by an emailed code
(g1); a parked assistant run resuming in its thread, the credit cap alerting at 80%, pausing at
100% and resuming after a top-up, and push falling back to WhatsApp and email (g2); an MCP
client's OAuth handshake, tool writes and reads with their audit, refresh rotation, revocation
and replays (g3); a member's own erasure and a contact's team-filed one that parks and is
approved by a second person (g4); and, on WhatsApp, a business claiming a number, a new number
writing in and becoming a contact, the orders PDF rendered in the worker, emailed with the same
bytes and sent by the assistant (to the person at once, to someone else parked), and a member
linking their number by code (g5). g0's 37 are the keyset walks and the F3, F5, S3, B12 and B13
checks.

Two things the first validation could not do were done. **WhatsApp with a claimed number**: g5
claims whaloc's seeded number at its start and releases it at its end (verified unclaimed
afterwards), so the order PDF's WhatsApp send and the WhatsApp intake, both "not testable" in
the first validation, ran; g2 mints a whaloc number per business. **Rate limits with the throttle
on**: with `ACC_THROTTLE=1`, g3 starts an API of its own on port 3210 (`THROTTLE=on`, its own
`BULL_PREFIX`, no worker) and checks that an MCP bearer counts per client (the 121st call is
429), that the OAuth token route and failed sign-ins count per caller address (a client's own
`x-forwarded-for` or `x-hykr-client-address` does not move it to another bucket), and that a
guest share route counts per caller address too.

The suites are rerunnable, outside the repository: `acc/` in the session folder named under
Evidence holds `g0.mjs` to `g5.mjs`, `probe0.mjs` and `probe-mcp-init.mjs`, each group's final
output and log (`g<n>.final.json`, `.log`; `g1.final2.*` for the rerun), the comparisons of the
two runs (`g<n>.compare.txt`) and `final-summary.json`. They import `../val/lib.mjs` (and
`../val/C8/mcp.mjs`), need an API and worker on `:3000` over `app_val`, and still name the
`ACC` worktree for the CLI and the scratchpad folder for their import files and the worker's
log: `node g0.mjs > out.json`, logs on stderr.

### What is still open

Acceptance fails nothing in its suites. One hand-driven lead stays, by design: `POST /mcp` with
a raw JSON-RPC `initialize` and no `MCP-Protocol-Version` header answers 400 "Unsupported
protocol version" (the MCP SDK's words, not the framework's; the 2026-07-28 revision has no
initialize handshake, and a real client lists tools). Words only; a line in the guide's MCP
section would be the follow-up (`acc/probe-mcp-init.mjs`). And `f63bb019` fixed one test: other
framework e2e tests also order audit rows by `at` alone and were not audited for the same tie.

What the units deferred, as it stands after every merge (each unit's Deferred section has the
detail; items a later unit closed are left out):

- **Untrusted input (V1, V10).** No process-wide prototype hardening (`--disable-proto`). A
  body value its column cannot hold (a date in the year 0000, a number past an `integer`) is a
  500 unless the entity's schema uses `storableDate()`, `storableDateTime()` or a `.max()` (guide
  section 14; the framework's and the sample's own body times do). A filter string on a number
  column (`id=x` on an integer key) is Postgres's: `bad_cursor` with a cursor, a 500 without
  (V10 decision 22). A signed webhook payload holding a NUL is refused whole, not cleaned. No
  warning for a drizzle foreign key to a tenant table that `traits.references` does not declare.
- **References (V2).** A reference on a child entity is refused at boot; a referenced record's
  delete clears its links with no audit row of their own; no reference that needs write access
  to the target, or to several entity types; a reference no spec declares is still checked by
  the database alone, so for one without a composite key the existence oracle stays.
- **Money (V4, V10).** Rows stored with a made-up code before the fix are read as before and not
  repaired. A deployment cannot add currency codes Intl omits (`VED`, the fund codes).
- **Erasure (V3, V8).** The approval of a parked create names no record, so its input keeps
  the words once decided. Mastra's spans and scores that land seconds after an erasure stay
  until `assistant.traces` retention. Text already delivered (a WhatsApp message, an email, a
  push, an inbox item about a record that stays) is not rewritten. Jobs in flight that carry an
  erased row are delivered. A run of another person's assistant that read the erased record
  through a tool keeps what it read; so does a run suspended on a request the erasure deleted.
  A document sent to an email keeps the address. Retention reaches live rows only. A finished
  job naming the person by display name alone is not matched.
- **Credits (V5, V11, V13).** The framework's paused sentence (`credits.paused`) still says the
  credits were used when a `tokens` or `tool_calls` limit refused the turn (the credits screen
  reads its status in its own language since V13, which closes V11's item on it).
  `limit_low_v1` and `limit_reached_v1` must be registered on every deployment
  (`templates:sync`). A `messages` limit that pauses nothing is
  silent. Under a plan pausing above 100%, the budget's share stops at 100 and a limit's alert
  can read past it. An agent's 402 is in English. A list before a module's own write tool,
  refused, still shows.
- **Retries and events (V6, V11).** Files and jobs still write outside `runWrite`. Chat turns,
  new threads, voice sessions and the WhatsApp link's routes ignore the idempotency key. A
  stored event the envelope refuses stays failed with no retry and no screen; a subscriber or
  notification whose filter threw never gets that event. A storage call has no timeout, so a
  discard past `CLAIM_STALE_MS` can be taken over by a retry. An application's own code that
  reaches the pool inside a transaction is found only by running its suite with every pool at
  one connection.
- **Words (V7, V13).** A team-decided request on WhatsApp gets no `/approvals/<id>` link.
  Three leads V13 left for others: an asked-for list on WhatsApp says its rows in the reply and
  again in the view's words ("You have no orders." then "No orders.", the sample's script); the
  states feature's refusal of a move from the wrong state writes "A" before every label ("A
  order that is draft can't take Approve"); and the operator's usage report in the back office
  lists meters by name (`tool_calls 12`).
- **Auth and approvals (V9, V11).** The fallback to `approvals.decide` when a named approver
  leaves is not announced to them. `TRUST_PROXY=true` takes the leftmost forwarded address, right
  only behind a balancer that overwrites the header. V9's leads checked by reading (L4, L5, L6,
  L10) were driven live by g3, but have no test in the repository.
- **Paging (V12).** For one page of a walk begun before the deploy, a cursor made before the fix
  may repeat rows of its millisecond, and a ledger `next` or delivery `nextBefore` made before it
  is read as a strict time and may skip unseen rows of that millisecond once.
- **MCP (A1, unchanged).** The framework features' tools and the platform commands are still
  not offered over MCP.

The owner questions above ("Judged by design") stand as they were. The units' own questions are
in the register ([README](README.md#assumptions-register), rows V1 to V13).

## Judged by design: questions for the owner

- **Approval bands do nothing in the sample (C2-1).** The `approvals` settings' `bands` and
  `thresholds` save, but the sample's orders name their own decider (`orders.approve`), which wins
  over the irreversible level's `{ band: 'money' }`, and the only other irreversible write (a
  team-filed erasure) carries no amount. A named approver per amount band works in the fixture's
  tests, never in the sample. Should the sample show it, as the plan's "Sample proof" asks?
- **No shared entity in the sample (C9-3).** Platform-shared records are proven on the fixture only;
  the plan's sample demos gave A11 a custom field and a flag. Should the sample share something?
- **A share link's recipient is checked for the business only (C4-1).** A member with
  `shares.create` who reaches none of a customer's records can still name that customer on a form
  link: the answers are filed as that customer, and an OTP-gated link sends a code to their number.
  B9 decisions 2 and 4 require reach for the target only. Should the recipient be checked against
  the maker's reach too?
- History labels another member's write as "you" (C3-2): documented in F4's Deferred section.

## Not tested here

No browser was connected and no device was used, so nothing on the app side ran: screens,
WebMCP in a browser, offline capture, push registration, live invalidation, the comments and
inbox components. Live models and voice did not run.

Of the 41 claims marked not testable, most need something the sample does not declare: an inbound
router, a shared entity, a job kind with callbacks or polling, a purchase provider, a supportable
capability that makes links, a flag that gates a module, an entity with a hidden state field or
with `comments: false`, a guest write that parks (V10's fixture test covers the form's answer).
Others were left alone to keep the shared deployment usable; the acceptance runs, on businesses
of their own, have since driven most of them: a business's meter limits reached (`tokens`,
`tool_calls`, embeddings, voice minutes: turns and agent calls 402, recall 402, the notices) and
MCP under the operator's pause (g2, g3); a person erased from their last business, whose login is
anonymised and refused, and whose old email is free for a new account that is not them (g5); and
the order PDF's WhatsApp send, which failed `unreachable` in the first validation because no
business had claimed whaloc's one number, now sent from a business that claims it and releases it
(g5). A poison stored event is still driven only by V6's e2e test, not in a deployment.

## Evidence

Outside the repository, in the session folder
`~/.claude/projects/-Volumes-Data-code-HyKr-basecamp/c9942275-1a74-46c4-87e5-67a85a38d187/validation/`:
`val/results.json` (every claim, defect and verdict), `val/confirmed.md`, each validator's
`val/C<n>/evidence.md` and scripts (rerunnable against `app_val` with `val/lib.mjs`), the CI,
eval and consumer logs, and the workflow journal. Two short outages of the shared API during C10
(16:36:20Z to 16:39:08Z: the pollution itself, then a stopped process) were rechecked: the one
verifier that ran inside them (C8-3) reran after the restart with the same result.
