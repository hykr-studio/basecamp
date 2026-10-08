// The eval runner both evals share: a fresh user through the API, the domain's setup, one
// runEvals per agent profile, and a PASS/FAIL report that exits 1 on any miss.
import { randomUUID } from 'node:crypto';
import type { Surface } from '@app/contracts';
import { type MastraScorer, runEvals } from '@mastra/core/evals';
import { RequestContext } from '@mastra/core/request-context';
import type { EvalCase } from '../src/agent-domain.js';
import { AGENT_KEYS, profileFor } from '../src/agents.js';
import { agentDomain } from '../src/domain/index.js';
import { mastra } from '../src/mastra/index.js';
import { modelId } from '../src/version.js';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';
export const APP: Surface[] = ['inline', 'canvas'];

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

/** A fresh user with the domain's eval data, so each run starts from the same place. */
export async function prepare(what: string) {
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
  console.log(`Evaluating ${what} with ${model}, acting for a fresh user\n`);
  return userId;
}

type Row = { case: string; input: string; scores: Record<string, number>; reasons: string[] };

/**
 * Run the cases in order, one runEvals per profile (each targets the agent with that
 * profile's tools). `extra` adds per-case request context (a language, a channel).
 */
export async function runCases<C extends EvalCase>(
  userId: string,
  cases: C[],
  // biome-ignore lint/suspicious/noExplicitAny: scorers of any input and output type
  scorers: MastraScorer<any, any, any, any>[],
  extra: (c: C, ctx: RequestContext) => void = () => {},
  groundTruth: (c: C) => unknown = (c) => c.expect,
): Promise<Row[]> {
  const rows: Row[] = [];
  // Consecutive cases with the same profile run together, in the order they are written:
  // later cases rely on earlier ones, so the conversation keeps its order across profiles.
  const runs: C[][] = [];
  for (const c of cases) {
    const last = runs.at(-1);
    if (last && profileFor(last[0].surfaces ?? APP) === profileFor(c.surfaces ?? APP)) last.push(c);
    else runs.push([c]);
  }
  for (const group of runs) {
    const profile = profileFor(group[0].surfaces ?? APP);
    let next = 0; // concurrency 1: results arrive in the order of the data
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
        extra(c, requestContext);
        return { input: c.input, groundTruth: groundTruth(c), requestContext };
      }),
      onItemComplete: ({ item, scorerResults }) => {
        const c = group[next++];
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
  if (rows.length !== cases.length)
    rows.push({
      case: `only ${rows.length} of ${cases.length} cases ran`,
      input: '',
      scores: { complete: 0 },
      reasons: [],
    });
  return rows;
}

/** PASS/FAIL per turn; exits 1 if any turn missed. */
export function report(rows: Row[]): never {
  if (rows.length === 0) {
    console.log('No cases ran: nothing was evaluated.');
    process.exit(1);
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
}
