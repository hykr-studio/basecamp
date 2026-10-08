import { commands } from '@app/contracts';
import { type Lang, scriptCounts } from '@app/i18n';
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

/**
 * Writes that act on an existing row (updates, deletes, any command that changes records), so
 * need an id first. A command that touches no records (handing the conversation to a person)
 * needs no lookup.
 */
const commandTools = new Set(
  commands.flatMap((c) => (c.tool && (c.touches?.length ?? 1) > 0 ? [c.tool] : [])),
);
const isWrite = (tool: string) => /^(update|delete)-/.test(tool) || commandTools.has(tool);
const isLookup = (tool: string) => /^(list|get)-/.test(tool);

/** "Look things up before changing them; never invent ids." */
export const listBeforeWrite = createScorer({
  id: 'list-before-write',
  name: 'Looks up before changing',
  description: 'Every update, delete or command in a turn comes after a list or get call.',
  type: 'agent',
})
  .preprocess(({ run }) => {
    const calls = callsIn(run.output);
    const firstList = calls.findIndex((c) => isLookup(c.toolName));
    const blind = calls.filter(
      (c, i) => isWrite(c.toolName) && (firstList === -1 || i < firstList),
    );
    return { writes: calls.filter((c) => isWrite(c.toolName)).length, blind: blind.length };
  })
  .generateScore(({ results }) => (results.preprocessStepResult.blind === 0 ? 1 : 0))
  .generateReason(({ results }) => {
    const { writes, blind } = results.preprocessStepResult;
    if (writes === 0) return 'No updates or deletes this turn.';
    return blind === 0
      ? `All ${writes} write(s) came after a lookup.`
      : `${blind} of ${writes} write(s) happened before any list or get call.`;
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
export type Expected = {
  must: string[];
  mustNot?: string[];
  replyIncludes?: string;
  /** Words the reply must not contain (the text surface never mentions a canvas or screen). */
  replyExcludes?: string[];
};

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
    const lower = reply.toLowerCase();
    const replyMatches =
      (!expected.replyIncludes || lower.includes(expected.replyIncludes.toLowerCase())) &&
      !(expected.replyExcludes ?? []).some((w) => lower.includes(w.toLowerCase()));
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
      : `reply missing or mentioning the wrong words: "${r.reply.slice(0, 80)}"`;
    return `${tools}; ${reply}`;
  });

/** What a voice eval case expects beyond its tools: the language the answer is in. */
export type VoiceExpected = Expected & { lang: Lang };

/** Enough letters to be a word in the language, not a stray character. */
const MIN_LETTERS = 3;

const reply = (output: AgentOutput) => extractAgentResponseMessages(output).join('\n').trim();

/** "Reply in {language}": the answer is written in the turn's script. */
export const repliesInLanguage = createScorer({
  id: 'replies-in-language',
  name: 'Answers in the turn’s language',
  description: 'Hindi in Devanagari, Telugu in Telugu script, English in neither.',
  type: 'agent',
})
  .preprocess(({ run }) => {
    const text = reply(run.output);
    const want = (run.groundTruth as VoiceExpected | undefined)?.lang ?? 'en';
    // Titles stay as the person said them, so a Telugu answer may hold English words (a list
    // of English titles may even be most of it). So: an Indian language needs real words in
    // its script (a few letters, not a stray sign) and none in the other's; English needs
    // none in either. Quoted titles never count.
    const own = text.replace(/"[^"]*"|“[^”]*”|‘[^’]*’/g, '');
    const { hi, te, en } = scriptCounts(own);
    const got =
      te >= MIN_LETTERS && hi === 0
        ? 'te'
        : hi >= MIN_LETTERS && te === 0
          ? 'hi'
          : hi === 0 && te === 0 && en > 0
            ? 'en'
            : 'mixed';
    return { want, got, text };
  })
  .generateScore(({ results }) => {
    const { want, got } = results.preprocessStepResult;
    return want === got ? 1 : 0;
  })
  .generateReason(({ results }) => {
    const { want, got, text } = results.preprocessStepResult;
    return want === got ? `Answered in ${want}.` : `Expected ${want}, got ${got}: "${text}"`;
  });

/** Two short sentences, said aloud: about fifteen seconds. */
const MAX_SPOKEN_CHARS = 240;

/** "On channel voice: at most two short sentences." */
export const briefForVoice = createScorer({
  id: 'brief-for-voice',
  name: 'Short enough to say',
  description: 'A spoken answer is at most two sentences; lists and details are on screen.',
  type: 'agent',
})
  .preprocess(({ run }) => {
    const text = reply(run.output);
    // A line break is a sentence too: a list read out line by line is not brief.
    const sentences = text.split(/(?<=[.!?।])\s+|\n+/).filter((s) => s.trim()).length;
    return { sentences, chars: text.length, text };
  })
  .generateScore(({ results }) => {
    const { sentences, chars } = results.preprocessStepResult;
    return sentences <= 2 && chars <= MAX_SPOKEN_CHARS ? 1 : 0;
  })
  .generateReason(({ results }) => {
    const { sentences, chars, text } = results.preprocessStepResult;
    return `${sentences} sentence(s), ${chars} characters: "${text}"`;
  });
