export const meta = {
  name: 'review-incremental',
  description: 'Deep line-by-line review (Workflow A): shard fleet + cross-cutting reviewers, independent verification, draft report',
  whenToUse: 'Full, incremental, ci or pilot engineering review of agentic-stack-template',
  phases: [
    { title: 'Review', detail: 'shard reviewers (2 lenses each) + cross-cutting reviewers' },
    { title: 'Docs', detail: 'claim extraction and checking per doc chunk' },
    { title: 'Verify', detail: 'independent verifier per finding, opposite model' },
    { title: 'Gaps', detail: 'files not seen by two reviewers' },
    { title: 'Report', detail: 'merge, findings.json, REPORT.md, fix plan, self-check' },
  ],
}

const A = args || {}
const REPO = A.repo
const RUN = A.runDate
const MODE = A.mode || 'full'
const PILOT = MODE === 'pilot'
const SHARDS = (A.shards || []).filter(s => !A.onlyShards || A.onlyShards.includes(s.id))
const DOC_CHUNKS = PILOT ? [] : (A.docChunks || [])
const FOCUS = A.focus || ''

const PREAMBLE = `You are part of a deep engineering review of the repository at ${REPO} (agentic-stack-template, product name "Basecamp"): a TypeScript pnpm/turbo monorepo — NestJS 11 + @nestjs/cqrs API, Better Auth, Drizzle on Postgres+PostGIS, Redis, BullMQ, Mastra agents via OpenRouter (scripted fake model for tests), Zod contracts, Expo/React Native app with assistant-ui, LiveKit voice worker, WhatsApp channel (whaloc locally), back-office app.
Run date: ${RUN}. Reviewed commit: ${A.commit}. Mode: ${MODE}.${FOCUS ? ' Focus note from the owner: ' + FOCUS : ''}

INTENDED DESIGN. docs/developer-guide.md is the living, authoritative guide (with README.md, DOMAIN.md, docs/tutorial.md). Its section 15 maps an older outline (packages/domain, defineEntity('X',{scope}), pnpm gen:client, packages/evals, messages/*.json, defineQuery) to what exists — differences listed there are NOT findings. Section 14 "Not ready yet" lists known gaps — report them only under knownGaps, unless the code contradicts the docs or breaks a rule.
THE THREE ARCHITECTURE RULES: (1) One write path: every business write goes through runWrite (packages/core/src/write/pipeline.ts): validate, idempotency, load, authorize, park-or-run, audit; events after commit. (2) The agent is a user: agent tools call the same HTTP API as the app as an agent principal (x-agent-key, x-acting-for); same rules, scopes, approvals, audit; no DB access. (3) Channels are views: app, WhatsApp and voice reach one chat service and one thread per person; tool results carry present intents; channel code makes no business decisions/writes/authorization.
Framework packages (public API): packages/core, contracts (framework/ and platform/), ui-registry, channels, notifications, policy. Everything else is internal. Unused exports in framework packages = "no internal consumer" (severity Low, informational) not dead code.

DEFAULTS WHEN AMBIGUOUS (do not stop; record a question): code beats docs (doc is stale) unless the code breaks one of the three rules (then code is wrong). Scaffolded-but-incomplete code = in progress → knownGaps, but still report contradictions with docs/rules. DX audience: product developer on macOS/Linux with VS Code.

EVIDENCE RULES: every finding cites path + startLine/endLine (repo-relative paths) for every location; quote the minimum code. Distinguish fact from judgement. No style nits a linter enforces. For duplicates name the canonical copy and why. For unused code state how you confirmed (rg for string-keyed use, decorators, Nest DI, CQRS handler registration, Mastra tool registration, defineX registries, dynamic imports, Expo Router file routing, public framework API). Prefer fewer, real findings over speculative ones; put suspicions you cannot back with code in "unverified concerns" (use severity Low and title prefix "Concern:" only if strongly suspected; otherwise omit).
SEVERITY: Critical = violates one of the three rules, bypasses authZ/approval/audit, a documented safety guarantee is false; bugs causing data loss, cross-user/tenant leak, authZ/approval bypass, double-send/double-write, security flaws. High = business logic coupled to a technology; duplicated business rule that can drift; docs instruct something that fails or misleads; bug in a normal flow; broken setup path or documented workflow that fails. Medium = unused/duplicated technical code; missing abstraction with several hand-rolled copies; doc drift in names/signatures; bug only in an edge case; DX friction that costs every developer on every feature. Low = minor dead code, small doc omissions, naming inconsistencies, polish.
SECRETS: never print, quote or copy secret values from .env*, keys, tokens or connection strings — refer to file, line and variable name only. The root .env is the owner's local file: you may read variable NAMES only.
SAFETY OF THE MACHINE: This is Workflow A — DO NOT modify tracked source files. Temporary repro tests must live under review/repro/ ; if one must sit inside a package to run, copy it in, run it, and delete it immediately (git status must show nothing but review/ afterwards). The owner's docker compose stack (postgres, redis, whaloc :8080, whaloc-test :8090, mailpit, minio, livekit, pgadmin) and dev servers (:3000, :8081, :8082) are running: never stop, restart or reconfigure them, never drop/truncate/delete existing data in the 'app' database. You may create separate databases (e.g. review_*) in that postgres and use unique data. Never send real messages, call paid APIs with real keys, git push, or touch non-local infrastructure. Never commit.`

const LOC = { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path', 'startLine', 'endLine'] }
const FINDING = {
  type: 'object',
  properties: {
    objective: { type: 'string', enum: ['unused', 'duplicate', 'architecture', 'docs', 'dx', 'bug'] },
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
    title: { type: 'string' },
    locations: { type: 'array', items: LOC, minItems: 1 },
    explanation: { type: 'string' },
    evidence: { type: 'string', description: 'minimal quoted code, commands and outputs' },
    recommendedFix: { type: 'string', description: 'include canonical copy / where the abstraction should live' },
    assumedQuestion: { type: 'string', description: 'empty unless the finding depends on an ambiguous assumption; then the question text' },
  },
  required: ['objective', 'severity', 'title', 'locations', 'explanation', 'evidence', 'recommendedFix'],
}
const QUESTION = { type: 'object', properties: { topic: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, assumedDefault: { type: 'string' } }, required: ['question', 'options', 'assumedDefault'] }
const FRICTION = { type: 'object', properties: { where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' } }, required: ['where', 'what', 'fix'] }
const LEDGER = { type: 'object', properties: { path: { type: 'string' }, read: { type: 'boolean' }, linesRead: { type: 'integer' }, responsibility: { type: 'string' }, note: { type: 'string' } }, required: ['path', 'read', 'responsibility'] }
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    ledger: { type: 'array', items: LEDGER },
    questions: { type: 'array', items: QUESTION },
    friction: { type: 'array', items: FRICTION },
    knownGaps: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'short summary for the report (e.g. swap-test rows, flow trace summary, measurements)' },
  },
  required: ['findings', 'ledger', 'questions', 'friction', 'knownGaps', 'notes'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['Verified', 'Plausible', 'Rejected'] },
    severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
    method: { type: 'string', description: 'test / reproduction / independent search / import chain / side-by-side / measurement' },
    command: { type: 'string' },
    output: { type: 'string', description: 'trimmed output, no secrets' },
    reasoning: { type: 'string' },
    correctedLocations: { type: 'array', items: LOC },
    revisedTitle: { type: 'string' },
    revisedFix: { type: 'string' },
    knownGap: { type: 'boolean', description: 'true if this is actually a documented "not ready yet" gap' },
  },
  required: ['status', 'severity', 'method', 'command', 'output', 'reasoning'],
}
const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' }, kind: { type: 'string' }, claim: { type: 'string' } }, required: ['line', 'kind', 'claim'] } },
  },
  required: ['claims'],
}
const CHECKED_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' }, claim: { type: 'string' }, status: { type: 'string', enum: ['Matches', 'Differs', 'Missing in code', 'Unverifiable'] }, evidence: { type: 'string' } }, required: ['line', 'claim', 'status', 'evidence'] } },
    findings: { type: 'array', items: FINDING },
    ledger: { type: 'array', items: LEDGER },
    questions: { type: 'array', items: QUESTION },
    friction: { type: 'array', items: FRICTION },
  },
  required: ['claims', 'findings', 'ledger', 'questions', 'friction'],
}

const ctr = { n: 0 }
const allFindings = []   // {pid, source, model, finding, verdict, mergedFrom: []}
const ledgerRows = []    // {path, reviewer}
const questions = []
const friction = []
const knownGaps = []
const notes = []

const SENSITIVE = /runWrite|write\/|approval|policy|auth|guard|webhook|whatsapp|inbound|queue|processor|bullmq|notify|dispatch|token|scop|tenant|agent-key|acting/i
const famOf = o => (o === 'unused' || o === 'duplicate') ? 'code' : o

function claim(source, model, f) {
  const loc = f.locations[0]
  const fam = famOf(f.objective)
  const dup = allFindings.find(x => famOf(x.finding.objective) === fam && x.finding.locations[0].path === loc.path && Math.abs(x.finding.locations[0].startLine - loc.startLine) <= 3)
  if (dup) { dup.mergedFrom.push({ source, title: f.title, locations: f.locations, severity: f.severity }); return null }
  ctr.n += 1
  const rec = { pid: 'P' + String(ctr.n).padStart(4, '0'), source, model, finding: f, verdict: null, mergedFrom: [] }
  allFindings.push(rec)
  return rec
}

function absorb(source, model, r) {
  if (!r) return []
  for (const l of (r.ledger || [])) if (l.read) ledgerRows.push({ path: l.path, reviewer: source })
  for (const q of (r.questions || [])) questions.push({ ...q, source })
  for (const f of (r.friction || [])) friction.push({ ...f, source })
  for (const g of (r.knownGaps || [])) knownGaps.push({ gap: g, source })
  if (r.notes) notes.push({ source, notes: r.notes })
  return (r.findings || []).map(f => claim(source, model, f)).filter(Boolean)
}

async function verify(rec) {
  const f = rec.finding
  const sensitive = f.severity === 'Critical' || f.severity === 'High' || f.locations.some(l => SENSITIVE.test(l.path)) || SENSITIVE.test(f.title)
  const model = sensitive ? 'opus' : (rec.model === 'opus' ? 'sonnet' : 'opus')
  const how = {
    bug: 'Write a failing test or run a concrete reproduction (HTTP request against a locally booted API on a free port, a script, a fake-model conversation, a whaloc control-API call on the test instance :8090). Record command and output. If reproduction is impractical but the code path clearly shows it, give the exact path and why reproduction was not practical (then status Plausible unless the path is unambiguous).',
    unused: 'Re-run the search independently: rg for the symbol and string-keyed uses, decorators, Nest DI tokens, CQRS registration, Mastra tool registration, defineX registries, dynamic imports, Expo Router file routing, package exports maps, scripts, tests. If it is a framework package export, it is at most "no internal consumer" (Low).',
    duplicate: 'Read every copy and confirm they implement the same behaviour (not just similar text). Confirm which copy should be canonical.',
    architecture: 'Show the import or call chain (file:line → file:line) that breaks the rule, or refute it.',
    docs: 'Show the doc line and the code line side by side, or run the documented command (if safe) and show its actual output.',
    dx: 'Show the measurement, the failing step, or the concrete file/line evidence of the friction.',
  }[f.objective]
  const v = await agent(`${PREAMBLE}

You are an INDEPENDENT VERIFIER. Another reviewer raised the finding below. Do not trust it: re-derive it yourself from the repository. Default to Rejected if the claim is wrong, already handled elsewhere in the code, is a documented known gap with no contradiction (then knownGap=true and Rejected), or is a style nit. Confirm or correct the severity using the rubric. Correct the locations if they are off.
Method for this kind of finding: ${how}
Status: Verified (reproduced / independently confirmed with evidence), Plausible (strong code evidence, not reproduced — say why), Rejected.

FINDING ${rec.pid} (objective: ${f.objective}, claimed severity: ${f.severity})
Title: ${f.title}
Locations: ${JSON.stringify(f.locations)}
Claim: ${f.explanation}
Cited evidence: ${f.evidence}
Proposed fix: ${f.recommendedFix}
${rec.mergedFrom.length ? 'Also raised (merged): ' + JSON.stringify(rec.mergedFrom).slice(0, 3000) : ''}

When done, write a JSON file review/raw/verify/${rec.pid}.json containing {"pid":"${rec.pid}","source":"${rec.source}","raisedModel":"${rec.model}","verifierModel":"${model}","finding":<the finding above as JSON, with any corrections applied>,"mergedFrom":<as given>,"verdict":<your verdict object>} — then return the verdict.`, { label: `verify:${rec.pid}:${f.objective}`, phase: 'Verify', schema: VERDICT_SCHEMA, model })
  const target = allFindings.find(x => x.pid === rec.pid) || rec
  target.verdict = v
  return target
}

function reviewPrompt(shard, lens) {
  const lensText = lens === 'structure'
    ? `LENS: STRUCTURE (objectives 1 and 2).
- Unused code: exported symbols with no importers, unexported functions never called, unused files, unused deps in this package's package.json (and used-but-undeclared deps), dead branches, unreachable/commented-out code, stale flags, unused env vars, unused DB columns/tables, unused Zod schemas, unused i18n keys, templates, BullMQ queues/processors, Mastra tools, registry views, package.json scripts. Confirm each with rg across the whole repo (string keys, DI, decorators, registries, dynamic imports, Expo file routing).
- Duplicates: copy-paste and semantic duplication (two pagination helpers, two auth checks, a Zod schema redefined instead of imported from contracts, hand-written types that should be z.infer, same constant twice, a business rule in both API and client). Search the rest of the repo for the other copy. Name the canonical copy.
- Architecture: dependency direction (framework must not import business/product code; domain must not import infra libs directly), the three rules (any direct Drizzle insert/update/delete or raw SQL outside runWrite in controllers/processors/tools/webhooks/seeds/voice; tools that reach DB/services or skip authZ/approval or have their own schemas; business decisions/writes/authZ in channel code; channel-specific branching in domain/core), abstraction completeness (hand-rolled CRUD controllers, manual pagination, manual Zod parsing in controllers, ad-hoc audit/event emission, per-feature approval logic, data hooks duplicating useEntityList/useEntityMutation/useCommand), abstraction quality (leaky signatures e.g. Drizzle types in defineEntity's public API, WhatsApp-specific fields in ChannelAdapter, React in defineView, single-consumer indirection, unused config options), contracts as single source of truth, cross-cutting consistency (errors, logging, config loading, i18n en/hi/te, tenant/owner scoping).`
    : `LENS: BEHAVIOUR (objectives 4 and 5, plus code-level doc drift).
- Bugs and security: write-path correctness (idempotency under retries/concurrency via unique keys, authZ against the row loaded in the transaction, audit in the same transaction, events only after commit, approval replay re-checking authZ and state and safe if replayed twice), concurrency (read-modify-write races, missing locks/version checks, per-contact locks that deadlock/leak, non-idempotent BullMQ jobs, double-sends, cancelOn races), scoping/IDOR (owner/tenant/customer on every read/list/search/count/cursor, ids in params/bodies/buttons/deep links, customer principals reaching staff actions, minAssurance), input validation on every external input (HTTP, webhooks, queue payloads, tool args, LLM output used as data), webhook HMAC on the raw body with constant-time compare, approval tokens single-use/expiry/contact-bound, cursor tampering, server-side page limits, prompt injection, data leaking into prompts/logs/traces, WhatsApp 24h window, templates outside the window, consent, quiet hours, STOP, provider-message-id dedupe, swallowed errors, retryable vs permanent misclassification, unhandled rejections, missing timeouts on external calls, leaks in long-lived workers, timezone (IST vs UTC), PostGIS coordinate order, i18n fallbacks showing keys, secrets in code/logs, unsafe production defaults, CORS/cookies.
- DX in code: any / as / @ts-ignore / @ts-expect-error / biome-ignore (count them per file in notes and judge each), whether misconfiguration fails at type-check, startup or runtime, error message quality, consistency of naming/scripts.
- Comments and JSDoc in the code that contradict the code; code that contradicts docs/developer-guide.md (grep the guide for the symbols in your files).`
  return `${PREAMBLE}

You are reviewer ${shard.id}/${lens}. Read EVERY file below IN FULL, line by line (use Read on each; for files over 2000 lines read in pages). You may read any other file in the repo to confirm a finding, but your ledger must list exactly the files below.
Package: ${shard.pkg}${shard.framework ? ' (FRAMEWORK package — public API)' : ''}. Files (${shard.lines} lines):
${shard.files.map(f => '- ' + f).join('\n')}

${lensText}

For each file give a ledger row: read=true only if you read the whole file, linesRead, a one-line responsibility, and a note. If a file's responsibility is unclear or overlaps another file's, that is itself a finding.
Record ambiguities as questions with options and the default you assumed; mark dependent findings with assumedQuestion. Record developer friction you hit. List knownGaps (in-progress or documented not-ready items) as strings.
Before returning, write your full result as JSON to review/raw/review/${shard.id}-${lens}.json. Then return it.`
}

async function reviewShard(shard) {
  const lenses = ['structure', 'behaviour']
  const out = await parallel(lenses.map(lens => () => agent(reviewPrompt(shard, lens), { label: `review:${shard.id}:${lens}:${shard.pkg}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'sonnet' })
    .then(r => r || agent(reviewPrompt(shard, lens) + '\n(This is a retry after a failed first attempt.)', { label: `retry:${shard.id}:${lens}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'sonnet' }))
    .then(r => absorb(`${shard.id}-${lens}`, 'sonnet', r))))
  return out.filter(Boolean).flat()
}

const verifyAll = recs => parallel(recs.map(rec => () => verify(rec)))

// ---------- cross-cutting reviewers ----------
const XC = [
  { key: 'setup', model: 'sonnet', prompt: `TASK: Clone-to-running DX run (Objective 4 items 1, 2, 8; Phase 1b). Act as a newcomer.
1. git clone ${REPO} into a fresh directory under ${A.scratch}/clean-clone (local clone of the current commit). Follow README.md "Getting started" EXACTLY, timing each command (use \`/usr/bin/time -p\` or date arithmetic). Count commands until: app (web), API, agent with the fake model, whaloc and pgAdmin are up with data. Prerequisites declared and checked (Node via .nvmrc/engines, pnpm via packageManager, Docker)?
2. The owner's compose stack is already running on the documented ports: do NOT stop it. Instead validate compose with \`docker compose config -q\` in the clone, and run the DB steps against a NEW database you create (e.g. createdb review_clone via docker compose exec postgres, apply infra/postgres/init.sql to it, then migrate with DATABASE_URL/MIGRATE_DATABASE_URL pointing at it). Start the API from the clone on a free port (PORT env if supported) with MODEL_MODE=fake, check /health (or the documented health route), sign up, create a to-do via curl as the developer guide section 4 shows, and ask the chat endpoint something with the fake model. Stop what you started; drop review_clone at the end.
3. Configuration: is .env.example complete and commented vs every env var the code reads (rg process.env and config schemas)? Is env validated at startup with a schema; does a missing/wrong variable fail fast naming the variable and how to fix it? (Test by starting the API with one required var unset.) Sensible local defaults without cloud keys?
4. Docs DX: does the developer guide "first hour" path work as written?
Record every step where you had to guess, fix something, or read code (friction, in order). Raise DX findings (broken setup path = High). Put measured times in notes. Ledger: list README.md, .env.example, compose.yaml, infra/** , package.json, .nvmrc if you read them fully. Write your result JSON to review/raw/xc/setup.json and a readable account to review/dx-setup.md.` },
  { key: 'tools', model: 'sonnet', prompt: `TASK: Tool pass (Phase 2) then triage. Run, saving RAW output under review/tool-output/ (one file per tool):
- knip (pnpm dlx knip@latest --reporter json and a readable run; if it needs a config, write one to ${A.scratch}/knip.json and pass --config — do not add files to the repo outside review/)
- tsc --noEmit --noUnusedLocals --noUnusedParameters per package (use each package's tsconfig: pnpm exec tsc -p <pkg>/tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters)
- jscpd (pnpm dlx jscpd@latest --min-tokens 30 --reporters json,console --output review/tool-output/jscpd packages apps --ignore "**/node_modules/**,**/dist/**,**/.expo/**,**/drizzle/meta/**")
- dependency-cruiser: pnpm lint:deps, plus a full graph (npx depcruise apps packages --config .dependency-cruiser.cjs --output-type json > review/tool-output/depcruise.json) and cycles
- counts of any / as / @ts-ignore / @ts-expect-error / biome-ignore per package (rg)
- string-keyed cross-checks: env vars read vs declared in .env.example/config, i18n keys defined vs used, BullMQ queue names declared vs processed, template names, Mastra tool names, view ids — produce tables.
Tool output alone is NOT a finding: triage every lead by reading the code, discard false positives (DI, decorators, CQRS/Mastra registration, defineX registries, dynamic imports, Expo file routing, framework public API = Low "no internal consumer"). Return confirmed leads as findings (objectives unused/duplicate/dx/architecture) and summarise tool counts in notes (raw counts before triage, and after). Ledger: empty. Write result JSON to review/raw/xc/tools.json.` },
  { key: 'commands', model: 'sonnet', prompt: `TASK: Documented commands and feedback-loop timing (Objective 3 "run every documented command", Objective 4 item 8). In the main working tree ${REPO}: time pnpm install (warm), pnpm typecheck (cold: pass --force to turbo; then warm/cached), pnpm lint, pnpm lint:deps, pnpm build (cold --force, then cached), unit tests per package (pnpm --filter <pkg> test for core, channels, i18n, notifications, policy, ui-registry), the API e2e suite (pnpm --filter @app/api test; it uses the running Postgres/Redis with unique data and its own Redis prefix), a single e2e file in isolation, apps/voice-worker tests, apps/mobile test, pnpm templates:check, pnpm --filter @app/agents eval (fake model; never eval:live or any :live script), and docker compose config -q. Also: API restart time on a file change (pnpm --filter @app/api dev on a free port if possible, touch a file, measure; stop it), and whether Expo web reload is measurable (skip if it would disturb the owner's :8081 server — record as blocked). Note machine load (other review agents run concurrently; record uptime load average). For every documented command in README.md "Scripts"/"Testing" and developer-guide sections 4, 12, 13, compare actual behaviour to the doc. Failing/misleading documented commands are findings (docs or dx, High if a documented workflow fails). Record which tests fail at baseline (needed later so failures are not blamed on fixes). Write review/tool-output/commands.md (command, time, exit code, trimmed output) and result JSON to review/raw/xc/commands.json. Ledger: list turbo.json, package.json, biome.json, .github/workflows/ci.yml, vitest configs if read fully.` },
  { key: 'arch-graph', model: 'opus', prompt: `TASK: Architecture reviewer — layering and swap test (Objective 2). Build the actual package/app import graph (package.json deps + real imports: rg "from '@app/" across apps and packages; you may use npx depcruise apps packages --config .dependency-cruiser.cjs --output-type text). Compare with the intended layering in docs/developer-guide.md sections 2-3 and the import rules table, and with .dependency-cruiser.cjs: are the documented rules all present, correct, and actually enforced (try to find imports that violate the intent but slip past the regexes, e.g. via relative paths, dist paths, re-exports)? Framework→business imports, domain code importing infra libs directly (NestJS, Drizzle, Redis, BullMQ, Mastra, OpenRouter, LiveKit, Better Auth, Expo, React). Abstraction quality of defineEntity, defineCommand, runWrite, entitySpec/commandSpec, defineView/bindView, defineTemplate/defineNotification, ChannelAdapter: leaky types, WhatsApp-specific fields, React deps, single-consumer indirection, unused options. SWAP TEST: for ORM (Drizzle), queue (BullMQ), model provider (OpenRouter/Mastra), auth (Better Auth), voice (LiveKit/Sarvam), messaging (WhatsApp), UI kit — list the files that would change and whether any are business/domain code (coupling finding if so). Put the swap-test table and an "architecture as built" summary (graph as a mermaid or ascii list) in notes. Read packages/core, packages/contracts/src/framework, packages/channels, packages/ui-registry/src (non-domain) fully; ledger rows only for files read fully. Write result JSON to review/raw/xc/arch-graph.json.` },
  { key: 'arch-rules', model: 'opus', prompt: `TASK: Architecture reviewer — the three rules, repo-wide (Objective 2). (1) One write path: search every app/package for direct writes (db.insert/update/delete, .execute(sql\`, pool.query, tx.insert etc.) and classify each: inside runWrite / framework infra (audit, idempotency, approvals tables) / channel bookkeeping / maintenance job / seed or migration / VIOLATION. Business-data writes outside runWrite are Critical unless documented as exempt. (2) Agent is a user: every Mastra tool (packages/core/src/tools, packages/agents) — does it call the HTTP API with the agent principal, use the same schemas as the entity/command specs, and go through the same authZ/approvals? Any tool with its own validation schema, direct service/DB access, or skipped approval? Voice worker and back office also. (3) Channels are views: apps/api/src/channels/** and voice — any business decision, data write, or authorization made in channel code; any channel-specific branching in domain or core code. Give the full call chains (file:line → file:line). Also check cross-cutting consistency: error handling, logging, config loading, i18n, tenant/owner scoping done one way everywhere. Write result JSON to review/raw/xc/arch-rules.json; ledger rows only for files read fully.` },
  { key: 'security-core', model: 'opus', prompt: `TASK: Adversarial security reviewer #1 — checking the defences of OUR OWN code, proving issues with tests against the LOCAL stack only (never external systems; no exploits for third-party systems). Targets: PrincipalGuard and agent-key/acting-for handling; Better Auth session/cookie/CORS/trusted origins (web vs native); policy accessFor/rowAllowed and scoping on every read, list, search, count and cursor (owner, tenant, customer); IDOR via ids in params, bodies, WhatsApp button payloads, deep links, approval ids; customer principals reaching staff actions; minAssurance; runWrite (idempotency under concurrent duplicates — note developer guide §14 documents this as a known gap, so report only beyond what is documented; authZ against the row loaded in the transaction; audit in the same transaction; events after commit; rolled-back writes); approvals park-and-replay (re-check authZ and current state at replay; double replay; approval by someone not entitled; expiry); cursor tampering; server-side page limits incl. agent tool lower max; agent safety (prompt injection from notes/messages treated as data, tools exceeding the user's permissions, approvals the docs require, secrets/other users' data in prompts, traces, logs). Prove with tests: boot the API from apps/api/dist the way apps/api/test/support.ts does (build first if dist is stale: pnpm --filter @app/api build), keep repro tests in review/repro/ (copy into apps/api/test/ only to run, then delete). Write result JSON to review/raw/xc/security-core.json; ledger rows only for files read fully.` },
  { key: 'security-channels', model: 'opus', prompt: `TASK: Adversarial security reviewer #2 — WhatsApp/notifications/queues/voice defences in OUR OWN code, proven against the LOCAL stack only (whaloc-test on :8090 and its control API; never real WhatsApp). Targets: webhook signature (HMAC computed on the raw body, constant-time compare, verify token handshake), payload validation with Zod, dedupe on provider message id (actually unique at DB level?), per-contact locks (deadlock/leak), BullMQ job idempotency under retry, double-sends, scheduled notifications double-send and cancelOn races, signed approval tokens (single use, expiry, contact binding, replay), 24-hour window computation, templates outside the window, consent before every send, quiet hours (IST vs UTC), STOP/START keywords, erasure completeness, back-office API scoping (staff of business A reaching business B), handoff, voice worker auth (VOICE_AGENT_KEY, daily minutes), missing timeouts on Graph API/OpenRouter/Sarvam/LiveKit calls, retryable vs permanent error classification, swallowed errors, memory growth in long-lived workers, secrets in logs. Read apps/api/src/channels/** and packages/channels and packages/notifications fully. Repro tests in review/repro/ (copy into apps/api/test/ only to run, then delete). Write result JSON to review/raw/xc/security-channels.json; ledger rows only for files read fully.` },
  { key: 'flow-todo', model: 'sonnet', prompt: `TASK: Flow trace 1 (Phase 4): "Create a to-do from the app" — mobile screen/hook → api-client → HTTP route (generated controller) → guard → validation → runWrite steps → DB → audit → event/after-commit → client cache update. Name every file and function touched (file:line). Compare each step with the developer guide's description (section 2 "What a write does", 5.x) and README. Where code and doc differ → docs finding. Where the flow is broken → bug. Put the trace (numbered steps with file:line) in notes; also write it to review/raw/flows/1-create-todo.md. Result JSON to review/raw/xc/flow-todo.json.` },
  { key: 'flow-approval', model: 'opus', prompt: `TASK: Flow trace 2 (Phase 4): "CloseMeeting via the agent with an approval" — chat request → ChatService → Mastra agent (fake model script) → generated tool → HTTP call as agent principal → commandController → runWrite → authorize returns needsApproval → park (approvals table, token) → approval card in app / WhatsApp buttons → approve endpoint → replay through runWrite (authZ and state re-checked?) → audit → events. Name every file and function (file:line). Compare to the docs (developer guide 5.4, 5.8, 6.3, 7.x; tutorial). Actually run it against a locally booted API with the fake model if practical (see apps/api/test/domain/meetings.e2e.test.ts for how) and record the outcome. Docs mismatches → docs findings; broken behaviour → bug. Trace in notes and review/raw/flows/2-close-meeting-approval.md. Result JSON to review/raw/xc/flow-approval.json.` },
  { key: 'flow-whatsapp', model: 'opus', prompt: `TASK: Flow trace 3 (Phase 4): (a) "An inbound WhatsApp message that results in a write": webhook → signature → wa-inbound queue → inbound.processor → contact/tenant resolution → chat turn → tool → API → runWrite → reply rendered from present intent → wa-send queue → adapter → Graph API (whaloc). (b) "A scheduled notification sent by template": defineNotification → scheduling → notify-dispatch processor → consent/quiet hours/24h window → template send → status webhooks. Name every file and function (file:line); compare to developer guide section 8, DOMAIN.md, tutorial step 5 and 9. Docs mismatches → docs findings; broken behaviour → bug; business logic in channel code → architecture. Trace in notes and review/raw/flows/3-whatsapp.md. Result JSON to review/raw/xc/flow-whatsapp.json.` },
  { key: 'flow-voice', model: 'sonnet', prompt: `TASK: Flow trace 4 (Phase 4): "A voice turn" — mobile VoiceProvider → API voice module (token, room) → LiveKit → apps/voice-worker (STT Sarvam/fake, calls /api/chat as agent principal) → chat → reply → TTS → back. Name every file and function (file:line); compare to developer guide 8.3 and README. Docs mismatches → docs findings; broken behaviour → bug; voice worker holding rules/data → architecture. Trace in notes and review/raw/flows/4-voice.md. Result JSON to review/raw/xc/flow-voice.json.` },
  { key: 'dx-feature', model: 'sonnet', isolation: 'worktree', prompt: `TASK: The "add a feature" DX exercise (Objective 4 item 3), in your own isolated git worktree (you are already in one; never touch ${REPO} directly). Following ONLY docs/developer-guide.md (and the tutorial where the guide points to it), add a small new entity "bookmark" (title, url, owner-scoped) with one command (e.g. archive), one view, agent tool exposure, and one notification. Install deps (pnpm install --frozen-lockfile), build, typecheck. For the migration and tests use a NEW database you create in the running postgres (createdb review_dx via docker compose -f ${REPO}/compose.yaml exec postgres ...; apply infra/postgres/init.sql) — never the 'app' database; drop it at the end. Record: files created and edited (git diff --stat), lines of boilerplate vs business logic, every step that needed knowledge not in the docs, everything you had to register manually that could be automatic, and whether typecheck/tests catch mistakes early (deliberately try: a rule on a wrong field, a command without authorize, a view referencing a missing entity, a template missing a language — does it fail at type-check, startup or runtime, and is the message actionable?). Compare with what the guide/tutorial claims. Do not commit to main; leave the worktree changes uncommitted (it will be discarded). Put the measurements in notes, friction in order, and findings (dx/docs). Write the result JSON ALSO to ${REPO}/review/raw/xc/dx-feature.json (absolute path) and a readable account to ${REPO}/review/dx-add-feature.md.` },
  { key: 'dx-scorecard', model: 'sonnet', prompt: `TASK: DX scorecard (Objective 4 items 4-7, 9-13). For each item give rating Good / Needs work / Poor, evidence (file:line, counts, measurements), and the smallest change that most improves it: 4 scaffolding & codegen (generators? codegen automatic? CI fails on stale generated output, e.g. drizzle migrations vs schema: run pnpm --filter @app/db generate in a dry way ONLY if it does not write files — otherwise compare schema with latest snapshot by reading; templates:check), 5 API ergonomics of the defineX family (option names consistent? required options/ordering surprises? escape hatches?), 6 type safety & inference (Zod → spec → command → client → hook → view props; count any/as/@ts-ignore/@ts-expect-error per package and review each), 7 errors & feedback (where misconfiguration fails; framework error message quality; consistent client error shape), 9 testing DX (harness per layer, shared fixtures/factories, isolated single test, readable failures), 10 debugging & observability (requestId/runId across API/queue/agent/channel logs; Bull Board, Mastra Studio/Langfuse, audit screen reachable and documented; structured logs), 11 consistency & discoverability (naming of files/scripts/env/queues/tools; repo map), 12 guardrails (lint/depcruise rules enforcing the import rules and three rules; pre-commit hooks; formatter at root; .vscode settings and extension recommendations committed), 13 docs DX (one entry point, copy-paste recipes, samples match API). Put the scorecard as a markdown table in notes and in review/raw/xc/dx-scorecard.md. Findings: dx (and docs). Result JSON to review/raw/xc/dx-scorecard.json.` },
  { key: 'dup-cross', model: 'sonnet', after: 'tools', prompt: `TASK: Cross-package duplication and string-keyed unused sweep (Objective 1, cross-cutting). Use review/tool-output/ (jscpd, knip, string-keyed tables) as leads, and search semantically: two pagination/cursor helpers, two error-mappers, two auth/principal checks, two date/timezone helpers, Zod schemas redefined in apps instead of imported from contracts, hand-written TS types duplicating z.infer, constants (queue names, limits, languages, header names) defined twice, business rules implemented in both API and mobile/back-office/voice, mobile hooks duplicating useEntityList/useEntityMutation/useCommand, i18n phrases duplicated between packages/i18n and apps. Verify each by reading every copy; name the canonical copy and why. Also env vars declared but unread / read but undeclared, unused i18n keys, templates, queues/processors, Mastra tools, views, package.json scripts. Result JSON to review/raw/xc/dup-cross.json.` },
  { key: 'docs-reverse', model: 'sonnet', prompt: `TASK: Docs reverse direction (Objective 3). List implemented framework features, public exports of framework packages (core, contracts framework/platform, ui-registry, channels, notifications, policy, api-client), root and package scripts, env vars, routes, queues and conventions that NO doc in scope (README.md, DOMAIN.md, docs/developer-guide.md, docs/tutorial.md, apps/mobile/PRODUCT.md, apps/mobile/AGENTS.md, apps/api/test/whatsapp/conversations/README.md) mentions. Also docs marked "not ready yet"/"deferred" (developer guide §14, §15) that are in fact implemented, and the reverse. Check diagrams and repo maps (README "Repository layout", guide §2 mermaid, §3 tables) against the real tree and import graph. Findings: docs (Low for omissions, Medium for wrong names/signatures, High if misleading). Result JSON to review/raw/xc/docs-reverse.json.` },
]

const runXC = async x => {
  const p = `${PREAMBLE}\n\nYou are cross-cutting reviewer "${x.key}".\n${x.prompt}\nAlso record questions (ambiguities with options + assumed default), friction (developer confusion, in order), and knownGaps.`
  let r = await agent(p, { label: `xc:${x.key}`, phase: 'Review', schema: REVIEW_SCHEMA, model: x.model, isolation: x.isolation })
  if (!r) r = await agent(p + '\n(Retry after a failed first attempt.)', { label: `xc-retry:${x.key}`, phase: 'Review', schema: REVIEW_SCHEMA, model: x.model, isolation: x.isolation })
  if (!r) { knownGaps.push({ gap: `Cross-cutting reviewer ${x.key} failed twice — coverage gap`, source: 'orchestrator' }); return [] }
  return absorb(`xc-${x.key}`, x.model, r)
}

// ---------- docs pipeline ----------
const docsStage = chunk => agent(`${PREAMBLE}\n\nTASK: Extract EVERY concrete, checkable claim from ${chunk.path} lines ${chunk.from}-${chunk.to} (read that range in full): package names and paths, function/type names and signatures, option names, commands (pnpm scripts), env vars, ports, compose service names, queue names, route paths, folder layouts, import rules, order of steps in runWrite, request sequences, test commands, checkpoints, "definition of done" items, code samples (record each sample as one claim "sample at line N compiles against current API"). Return each with its line number and kind. Do not judge them.`, { label: `claims:${chunk.id}`, phase: 'Docs', schema: CLAIMS_SCHEMA, model: 'haiku' })
const checkStage = (claims, chunk) => { if (claims) ledgerRows.push({ path: chunk.path, reviewer: `claims-${chunk.id}` }); return checkStage2(claims, chunk) }
const checkStage2 = (claims, chunk) => agent(`${PREAMBLE}\n\nTASK: Docs pass (Objective 3) for ${chunk.path} lines ${chunk.from}-${chunk.to}. Read that range IN FULL yourself, then check every claim below against the code (rg, read the code). Mark each Matches / Differs (state what the code does, with file:line) / Missing in code / Unverifiable. For code samples: check identifiers, imports and signatures against the current API (you may typecheck a sample by writing it to ${A.scratch}/docsamples/ and compiling against the workspace packages, if practical). Commands: run them only if safe and quick (no :live scripts, no real sends); otherwise Unverifiable with why. Add any claims the extractor missed. Raise findings (objective docs) for every Differs / Missing in code that matters: severity High if the doc instructs something that would fail or mislead, Medium for name/signature drift, Low for small omissions. Ledger: one row for ${chunk.path} with read=true only if you read the full range (note the range). Write result JSON to review/raw/docs/${chunk.id}.json.\n\nCLAIMS:\n${JSON.stringify((claims && claims.claims) || []).slice(0, 60000)}`, { label: `docs:${chunk.id}`, phase: 'Docs', schema: CHECKED_SCHEMA, model: 'sonnet' })
  .then(r => { if (r) { notes.push({ source: `docs-${chunk.id}`, notes: `claims checked: ${r.claims.length}; differs: ${r.claims.filter(c => c.status !== 'Matches').length}` }) } return absorb(`docs-${chunk.id}`, 'sonnet', r) })

// ---------- run everything concurrently; verification pipelines per source ----------
phase('Review')
log(`${MODE}: ${SHARDS.length} shards × 2 lenses, ${PILOT ? 0 : XC.length} cross-cutting reviewers, ${DOC_CHUNKS.length} doc chunks`)

const shardWork = pipeline(SHARDS, s => reviewShard(s), recs => verifyAll(recs))
const xcIndependent = PILOT ? [] : XC.filter(x => !x.after && x.key !== 'tools')
const toolsX = XC.find(x => x.key === 'tools')
const dupX = XC.find(x => x.key === 'dup-cross')
const xcWork = PILOT ? Promise.resolve([]) : pipeline(xcIndependent, x => runXC(x), recs => verifyAll(recs))
const toolsWork = PILOT ? Promise.resolve([]) : runXC(toolsX).then(recs => parallel([() => verifyAll(recs), () => runXC(dupX).then(verifyAll)]))
const docsWork = pipeline(DOC_CHUNKS, c => docsStage(c), (claims, c) => checkStage(claims, c), recs => verifyAll(recs))

await parallel([() => shardWork, () => xcWork, () => toolsWork, () => docsWork])

// ---------- coverage gap fill: every in-scope file seen by ≥2 reviewers ----------
phase('Gaps')
const seenBy = {}
for (const r of ledgerRows) (seenBy[r.path] = seenBy[r.path] || new Set()).add(r.reviewer)
const allFiles = SHARDS.flatMap(s => s.files)
const thin = allFiles.filter(f => !seenBy[f] || seenBy[f].size < 2)
log(`coverage: ${allFiles.length - thin.length}/${allFiles.length} files seen by ≥2 reviewers; filling ${thin.length}`)
if (thin.length) {
  const groups = []
  for (let i = 0; i < thin.length; i += 12) groups.push(thin.slice(i, i + 12))
  await pipeline(groups, (g, _o, i) => agent(reviewPrompt({ id: 'GAP' + (i + 1), pkg: 'mixed', framework: false, lines: 0, files: g }, i % 2 ? 'structure' : 'behaviour') + '\nThese files were not yet read in full by two reviewers. Use BOTH lenses (structure and behaviour) for them.', { label: `gap:${i + 1}`, phase: 'Gaps', schema: REVIEW_SCHEMA, model: 'opus' })
    .then(r => absorb(`GAP${i + 1}`, 'opus', r)), recs => verifyAll(recs))
}
for (const r of ledgerRows) (seenBy[r.path] = seenBy[r.path] || new Set()).add(r.reviewer)
const stillThin = allFiles.filter(f => !seenBy[f] || seenBy[f].size < 2)

// ---------- summary + report ----------
const verified = allFindings.filter(r => r.verdict && r.verdict.status !== 'Rejected')
const counts = { raised: allFindings.length + allFindings.reduce((a, r) => a + r.mergedFrom.length, 0), unique: allFindings.length, verified: allFindings.filter(r => r.verdict && r.verdict.status === 'Verified').length, plausible: allFindings.filter(r => r.verdict && r.verdict.status === 'Plausible').length, rejected: allFindings.filter(r => r.verdict && r.verdict.status === 'Rejected').length, verifyFailed: allFindings.filter(r => !r.verdict).length }
const bySev = {}
for (const r of verified) bySev[r.verdict.severity] = (bySev[r.verdict.severity] || 0) + 1
const coverage = { files: allFiles.length, seenTwice: allFiles.length - stillThin.length, notSeenTwice: stillThin }

const summaryForDisk = JSON.stringify({ mode: MODE, counts, bySev, coverage, questions, friction, knownGaps, notes, unverifiedPids: allFindings.filter(r => !r.verdict).map(r => ({ pid: r.pid, finding: r.finding })), ledger: Object.fromEntries(Object.entries(seenBy).map(([k, v]) => [k, [...v]])) })

phase('Report')
if (PILOT) {
  const out = await agent(`${PREAMBLE}\n\nWrite this pilot summary JSON verbatim to review/raw/pilot-summary.json, then return the string "ok".\n${summaryForDisk}`, { label: 'pilot-persist', phase: 'Report', model: 'haiku' })
  return { counts, bySev, coverage, questions: questions.length, friction: friction.length, findings: allFindings.map(r => ({ pid: r.pid, obj: r.finding.objective, sev: r.verdict ? r.verdict.severity : r.finding.severity, status: r.verdict ? r.verdict.status : 'unverified', title: r.finding.title })) }
}

await agent(`${PREAMBLE}\n\nWrite the following JSON verbatim to review/raw/run-summary.json (it is the orchestrator's in-memory state: questions, friction, known gaps, notes, per-file reviewer ledger, counts). Then return "ok".\n${summaryForDisk}`, { label: 'persist-summary', phase: 'Report', model: 'haiku' })

const assemble = await agent(`${PREAMBLE}

You are the ASSEMBLER (Phase 6, part 1). Inputs on disk: review/raw/verify/*.json (one per finding: finding + verdict + mergedFrom), review/raw/review/*.json and review/raw/xc/*.json and review/raw/docs/*.json (reviewer outputs incl. ledger rows, questions, friction, knownGaps, notes), review/raw/run-summary.json, review/inventory.md (Phase 0 inventory, 407 files), review/tool-output/.
Write a node script under ${A.scratch}/assemble.mjs and run it, plus your own judgement, to produce:
1. review/findings.json — every NON-rejected finding, after SEMANTIC DEDUPLICATION across reviewers (same defect at different lines or raised by different lenses → one finding with all locations; read the code when unsure). Final IDs by objective: UNUSED-nnn, DUP-nnn, ARCH-nnn, DOC-nnn, DX-nnn, BUG-nnn, numbered by severity then path. Shape per item: {id, objective, severity, title, locations:[{path,startLine,endLine}], explanation, evidence, verification:{status, method, command, output, verifierModel}, assumedQuestion, recommendedFix, fixStatus:"Open", commit:null, sourcePids:[...], raisedBy:[...], knownGap:false}. Findings verifiers marked knownGap go to the known-gaps list, not findings.json. Resolve contradictions between findings by reading the code yourself.
2. review/rejected.md — every Rejected finding (pid, title, location, why rejected).
3. review/coverage-ledger.md — every one of the 407 inventory files: read by which reviewers, finding IDs, one-line responsibility. Totals must match the inventory; list any file not read by two reviewers with the reason.
4. review/doc-claims.md — every claim from review/raw/docs/*.json with status and evidence, grouped by doc.
5. review/dx-friction-log.md — every friction point in order (setup first), with the fix that would remove it; dedupe.
6. review/open-questions.md — merge all reviewer questions into numbered questions Q1..Qn grouped by theme (merge ones sharing an answer), each with options (a/b/c), assumed default, and dependent finding IDs (rewrite each finding's assumedQuestion to the matching Q id in findings.json).
7. review/known-gaps.md — known gaps (documented not-ready items, in-progress code) with any contradictions noted.
Return a short JSON-ish text summary: counts by objective × severity, number of dedup merges, questions count.`, { label: 'assemble', phase: 'Report', model: 'opus' })

const report = await agent(`${PREAMBLE}

You are the REPORT WRITER (Phase 6, part 2). Read review/findings.json, review/open-questions.md, review/known-gaps.md, review/coverage-ledger.md, review/doc-claims.md, review/dx-friction-log.md, review/rejected.md, review/raw/run-summary.json, review/raw/xc/*.json and *.md (setup, commands, tools, arch-graph swap test, dx-feature, dx-scorecard), review/raw/flows/*.md, review/tool-output/commands.md.
Write:
1. review/REPORT.md: Executive summary (verdict per objective; top ten findings; counts by severity; review quality numbers: raised ${counts.raised}, unique after merge ${counts.unique}, verified, plausible, rejected, files seen by ≥2 reviewers ${coverage.seenTwice}/${coverage.files}); Architecture as built vs intended; Findings grouped by objective (ID, severity, verification status + evidence, title, locations, evidence, why it matters, recommended fix incl. canonical copy) — sections ordered by severity; Swap-test table; Flow traces (Phase 4); DX scorecard (13 items, rating, evidence, top fix; measured times; add-a-feature results); Known gaps and assumed findings. Mark Plausible findings clearly.
2. review/fix-plan.md: findings ordered into a safe sequence of small changes, each keeping tests green, dependencies noted; quick DX wins (<1h, high impact) marked separately and first; order: quick DX wins and safe removals → duplication consolidation → framework/architecture → docs describing the final state. Removals carry their unused-verification evidence. Mark fixes that are risky, large (>300 lines / a day: write a short design note instead), change public framework API, or need an owner decision, with the question id. Group the fixes into review units (themes) for stacked branches, each <500 files and <8000 lines.
3. Self-check (append to REPORT.md "Review self-check"): ledger complete; every file seen by ≥2 reviewers (list exceptions); every finding has a location and verification status; no two findings contradict; every recommendation respects the three rules; no DX recommendation weakens authZ/approvals/audit/validation; parts of the repo not reviewed and why. Fix small inconsistencies you find in the files.
Also update review/state.json: phase "A-done" (Phases 0-6 complete), workflows.A "done", ledger done count.
Return: the executive summary text (verdicts per objective, top ten findings with IDs and severity, severity counts, fixes planned count, review units list).`, { label: 'report', phase: 'Report', model: 'opus' })

return { counts, bySev, coverage, assemble, report }
