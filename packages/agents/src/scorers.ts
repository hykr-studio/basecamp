import { createScorer } from '@mastra/core/evals';
import { extractAgentResponseMessages, mergeToolInvocations } from '@mastra/evals/scorers/utils';

/**
 * Code scorers: free, deterministic, and run on every agent turn. Each checks one
 * rule from the agent's instructions. Results show in Studio under Scorers.
 */

type Call = { toolName: string; args: unknown; ok: boolean | undefined };

type AgentOutput = Parameters<typeof extractAgentResponseMessages>[0];

/** Tool calls in the order the agent made them, with whether each one succeeded. */
export function callsIn(output: AgentOutput): Call[] {
  return output.flatMap((message) =>
    mergeToolInvocations(message).map((inv) => {
      const result = (inv as { result?: { ok?: boolean } }).result;
      return { toolName: inv.toolName, args: inv.args, ok: result?.ok };
    }),
  );
}

const WRITES = new Set(['update-todo', 'delete-todo']);

/** "Always call list-todos before changing anything." Ids must come from a list, never be guessed. */
export const listBeforeWrite = createScorer({
  id: 'list-before-write',
  name: 'Lists before changing',
  description: 'Every update or delete in a turn comes after a list-todos call.',
  type: 'agent',
})
  .preprocess(({ run }) => {
    const calls = callsIn(run.output);
    const firstList = calls.findIndex((c) => c.toolName === 'list-todos');
    const blind = calls.filter(
      (c, i) => WRITES.has(c.toolName) && (firstList === -1 || i < firstList),
    );
    return { writes: calls.filter((c) => WRITES.has(c.toolName)).length, blind: blind.length };
  })
  .generateScore(({ results }) => (results.preprocessStepResult.blind === 0 ? 1 : 0))
  .generateReason(({ results }) => {
    const { writes, blind } = results.preprocessStepResult;
    if (writes === 0) return 'No updates or deletes this turn.';
    return blind === 0
      ? `All ${writes} write(s) came after list-todos.`
      : `${blind} of ${writes} write(s) happened before any list-todos call.`;
  });

/** "If a tool returns ok:false, explain why; don't retry." */
export const noRetryAfterRefusal = createScorer({
  id: 'no-retry-after-refusal',
  name: "Doesn't retry refusals",
  description: 'After a tool returns ok:false, the same call is not made again.',
  type: 'agent',
})
  .preprocess(({ run }) => {
    const calls = callsIn(run.output);
    const key = (c: Call) => `${c.toolName}:${JSON.stringify(c.args)}`;
    const refused = new Set<string>();
    let retries = 0;
    for (const c of calls) {
      if (refused.has(key(c))) retries++;
      if (c.ok === false) refused.add(key(c));
    }
    return { refusals: refused.size, retries };
  })
  .generateScore(({ results }) => (results.preprocessStepResult.retries === 0 ? 1 : 0))
  .generateReason(({ results }) => {
    const { refusals, retries } = results.preprocessStepResult;
    if (refusals === 0) return 'No refusals this turn.';
    return retries === 0
      ? `${refusals} refusal(s), none retried.`
      : `Retried a refused call ${retries} time(s).`;
  });

/**
 * The dataset's expectation for one case. `must` tools run in this order (others may come
 * between, such as a list-todos first); `mustNot` tools never run.
 */
export type Expected = { must: string[]; mustNot?: string[]; replyIncludes?: string };

function inOrder(expected: string[], actual: string[]) {
  let i = 0;
  for (const tool of actual) if (tool === expected[i]) i++;
  return i === expected.length;
}

/** Eval-only: the turn called the tools it should, avoided the ones it shouldn't, and said so. */
export const expectedOutcome = createScorer({
  id: 'expected-outcome',
  name: 'Expected tools and reply',
  description:
    'Required tools ran in order, forbidden tools did not, and the reply has the expected words.',
  type: 'agent',
})
  .preprocess(({ run }) => {
    // Only eval cases carry an expectation; scored anywhere else, the check is vacuous.
    const expected = (run.groundTruth as Expected | undefined) ?? { must: [] };
    const tools = callsIn(run.output).map((c) => c.toolName);
    const reply = extractAgentResponseMessages(run.output).join('\n');
    const forbidden = (expected.mustNot ?? []).filter((t) => tools.includes(t));
    const toolsMatch = inOrder(expected.must, tools) && forbidden.length === 0;
    const replyMatches =
      !expected.replyIncludes || reply.toLowerCase().includes(expected.replyIncludes.toLowerCase());
    return { tools, must: expected.must, forbidden, toolsMatch, replyMatches, reply };
  })
  .generateScore(({ results }) => {
    const r = results.preprocessStepResult;
    return (r.toolsMatch ? 0.5 : 0) + (r.replyMatches ? 0.5 : 0);
  })
  .generateReason(({ results }) => {
    const r = results.preprocessStepResult;
    const called = r.tools.join(' → ') || 'none';
    const tools = r.toolsMatch
      ? `tools ok (${called})`
      : r.forbidden.length > 0
        ? `called forbidden ${r.forbidden.join(', ')} (${called})`
        : `called ${called}, needed ${r.must.join(' → ')}`;
    const reply = r.replyMatches
      ? 'reply ok'
      : `reply lacks expected words: "${r.reply.slice(0, 80)}"`;
    return `${tools}; ${reply}`;
  });
