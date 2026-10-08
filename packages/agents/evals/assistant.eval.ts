// Runs the assistant through the domain's eval conversation and scores every turn.
//
//   pnpm --filter @app/agents eval        scripted model: deterministic, free, for CI
//   pnpm --filter @app/agents eval:live   your AGENT_MODEL through OpenRouter
//
// It needs the API running: the agent's tools call it as a fresh test user, so each run
// starts from empty data. The cases and their setup come from the domain (src/domain).
// Exits 1 if any turn misses its expectation.
import { agentDomain } from '../src/domain/index.js';
import { expectedOutcome, listBeforeWrite, noRetryAfterRefusal } from '../src/scorers.js';
import { prepare, report, runCases } from './harness.js';

const userId = await prepare('the assistant');
report(
  await runCases(userId, agentDomain.evalCases, [
    expectedOutcome,
    listBeforeWrite,
    noRetryAfterRefusal,
  ]),
);
