// Runs the assistant through the application's eval conversation and scores every turn.
// `basecamp eval` (scripted model) or `basecamp eval --live` (your AGENT_MODEL).
//
// It needs the API running: the agent's tools call it as a fresh test user, so each run
// starts from empty data. The cases and their setup come from the application's agent domain.
import type { Agents } from '../agents.js';
import { expectedOutcome, listBeforeWrite, noRetryAfterRefusal } from '../scorers.js';
import { prepare, report, runCases } from './harness.js';

export async function evalAssistant(agents: Agents): Promise<boolean> {
  const userId = await prepare(agents, 'the assistant');
  return report(
    await runCases(agents, userId, agents.domain.evalCases, [
      expectedOutcome,
      listBeforeWrite(agents.catalog.commands),
      noRetryAfterRefusal,
    ]),
  );
}
