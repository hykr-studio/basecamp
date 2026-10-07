// Runs the assistant through the domain's eval conversation and scores every turn.
//
//   pnpm --filter @app/agents eval        scripted model: deterministic, free, for CI
//   pnpm --filter @app/agents eval:live   your AGENT_MODEL through OpenRouter
//
// It needs the API running: the agent's tools call it as a fresh test user, so each run
// starts from empty data. The cases and their setup come from the domain (src/domain).
// Exits 1 if any turn misses its expectation.
import { randomUUID } from 'node:crypto';
import type { Surface } from '@app/contracts';
import { runEvals } from '@mastra/core/evals';
import { RequestContext } from '@mastra/core/request-context';
import { AGENT_KEYS, profileFor } from '../src/agents.js';
import { agentDomain } from '../src/domain/index.js';
import { mastra } from '../src/mastra/index.js';
import { expectedOutcome, listBeforeWrite, noRetryAfterRefusal } from '../src/scorers.js';
import { modelId } from '../src/version.js';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';
const APP: Surface[] = ['inline', 'canvas'];

async function evalUser() {
  const email = `eval-${Date.now()}@example.com`;
  const res = await fetch(`${api}/api/auth/sign-up/email`, {
    method: 'POST',
    // Better Auth rejects browser-like requests (Node's fetch) without a trusted Origin.
    headers: { 'content-type': 'application/json', origin: api },
    body: JSON.stringify({ name: 'Eval', email, password: 'eval-password' }),
  });
  if (!res.ok) throw new Error(`Could not create the eval user (is the API running at ${api}?)`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { userId: ((await res.json()) as { user: { id: string } }).user.id, cookie };
}

const { userId, cookie } = await evalUser();
await agentDomain.evalSetup?.(async (method, path, body) => {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: api, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Eval setup ${method} ${path} failed: ${res.status}`);
  return res.json();
});
const model = process.env.MODEL_MODE === 'fake' ? 'scripted model' : modelId();
console.log(`Evaluating the assistant with ${model}, acting for a fresh user\n`);

const cases = agentDomain.evalCases;
const rows: { case: string; input: string; scores: Record<string, number>; reasons: string[] }[] =
  [];
const scorers = [expectedOutcome, listBeforeWrite, noRetryAfterRefusal];

// One run per surface profile: each targets the agent with that profile's tools.
for (const profile of ['app', 'inline', 'text'] as const) {
  const group = cases.filter((c) => profileFor(c.surfaces ?? APP) === profile);
  if (group.length === 0) continue;
  await runEvals({
    target: mastra.getAgent(AGENT_KEYS[profile]),
    concurrency: 1,
    scorers,
    targetOptions: { maxSteps: 8 },
    data: group.map((c) => {
      const requestContext = new RequestContext();
      requestContext.set('userId', userId);
      requestContext.set('runId', randomUUID().replaceAll('-', ''));
      requestContext.set('surfaces', c.surfaces ?? APP);
      if (c.canvas) requestContext.set('canvas', { page: c.canvas });
      return { input: c.input, groundTruth: c.expect, requestContext };
    }),
    onItemComplete: ({ item, scorerResults }) => {
      const c = group.find((x) => x.input === item.input && !rows.some((r) => r.case === x.why));
      const scores = Object.fromEntries(
        scorers.map((s) => [s.id, scorerResults[s.id]?.score ?? 0]),
      );
      const reasons = scorers
        .filter((s) => (scorerResults[s.id]?.score ?? 0) < 1)
        .map((s) => `${s.id}: ${scorerResults[s.id]?.reason}`);
      rows.push({
        case: c?.why ?? String(item.input),
        input: c?.input ?? String(item.input),
        scores,
        reasons,
      });
    },
  });
}

let failed = 0;
for (const [i, row] of rows.entries()) {
  const pass = Object.values(row.scores).every((s) => s === 1);
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${i + 1}. ${row.case}  "${row.input}"`);
  for (const reason of row.reasons) console.log(`        ${reason}`);
}
console.log(
  `\n${rows.length - failed}/${rows.length} turns passed. Scores and traces are in Studio.`,
);
process.exit(failed === 0 ? 0 : 1);
