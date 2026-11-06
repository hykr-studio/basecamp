// Runs the assistant through each module's eval conversation and scores every turn.
// `basecamp eval [--module <m>]` (scripted model) or `basecamp eval --live` (your AGENT_MODEL).
//
// It needs the API running: the agent's tools call it as a fresh test user per module, so each
// module starts from empty data. The cases and their setup come from the modules' agent parts.
import type { Agents } from '../agents.js';
import { suitesFor } from '../modules.js';
import { expectedOutcome, listBeforeWrite, noRetryAfterRefusal } from '../scorers.js';
import { prepare, type Row, report, runCases } from './harness.js';

export async function evalAssistant(
  agents: Agents,
  options: { module?: string } = {},
): Promise<boolean> {
  const rows: Row[] = [];
  for (const suite of suitesFor(agents.domain, options.module)) {
    if (!suite.evalCases.length) continue;
    const userId = await prepare(`the assistant (${suite.module})`, suite.evalSetup);
    rows.push(
      ...(await runCases(agents, userId, suite.evalCases, [
        expectedOutcome,
        listBeforeWrite(agents.catalog.commands),
        noRetryAfterRefusal,
      ])),
    );
  }
  return report(rows);
}
