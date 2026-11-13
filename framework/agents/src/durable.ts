// Durable runs (A7): a run whose write was parked is suspended (the tool calls Mastra's
// suspend(), see @hykr/core/tools), stored by Mastra, and resumed when the approval is decided.
// Here: the turn that suspended still answers as a parked one, finding a suspended run by its
// approval, and resuming it. docs/decisions/A7.md.
import { isParkedCall, type ParkedCall, type ResumeDecision } from '@hykr/core/tools';
import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
import type { MastraModelOutput } from '@mastra/core/stream';
import { type ParkedApproval, parkedLine, type TurnVoice, voiceOf } from './parked-line.js';

export { type ParkedApproval, parkedLine, type TurnVoice, voiceOf };

type RequestContextLike = { get(key: string): unknown } | undefined;

/** One call a run suspended on: Mastra's `tool-call-suspended` payload. */
type SuspendedCall = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  parked: ParkedCall;
};

type Chunk = { type: string; runId?: string; from?: string; payload?: Record<string, unknown> };

const parkedOf = (chunk: Chunk): SuspendedCall | undefined => {
  if (chunk.type !== 'tool-call-suspended' || !chunk.payload) return undefined;
  const { toolCallId, toolName, args, suspendPayload } = chunk.payload;
  return isParkedCall(suspendPayload) && typeof toolCallId === 'string'
    ? { toolCallId, toolName: String(toolName), args, parked: suspendPayload }
    : undefined;
};

/** A parked call as the tool result it would have been: what the tool showed while it waited. */
const resultChunk = (call: SuspendedCall, base: Pick<Chunk, 'runId' | 'from'>) => ({
  type: 'tool-result' as const,
  runId: base.runId ?? '',
  from: base.from ?? 'AGENT',
  payload: {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: call.args,
    result: call.parked.output,
  },
});

/** One line per waiting request (the same line once), after what the model said. */
function waitingText(text: string, calls: readonly SuspendedCall[], voice: TurnVoice) {
  const lines = [...new Set(calls.map((c) => parkedLine(c.parked, voice)))];
  return [text.trim(), ...lines].filter(Boolean).join('\n\n');
}

// biome-ignore lint/suspicious/noExplicitAny: whatever structured output the run has
type Output = MastraModelOutput<any>;

type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

/**
 * What one stream of a run carried: its parked calls, tool results, words and steps' usage, and
 * whether it ended with a `finish` or an `error` chunk.
 */
type Seen = {
  parked: SuspendedCall[];
  results: Chunk[];
  text: string;
  usage: Usage;
  ended?: 'finish' | 'error';
};

const add = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/**
 * A run's output, read as a parked turn when it suspended on parked writes: each such call is a
 * tool result carrying what its tool showed (the approval card), and the reply ends with the
 * waiting line. The stream gets the same: a `tool-result` chunk in place of each
 * `tool-call-suspended`, and the line as text at the end. Everything else is Mastra's own.
 *
 * `resumed`: the output of a resumed run, whose text, tool results and usage Mastra counts from
 * the run's start. They are taken from this stream alone instead: what the run did and said
 * after the decision, and what its model calls used since (the step that parked included: the
 * turn that parked did not count it).
 *
 * `finishReason` is 'suspended' too for a stream that ended with neither a finish nor an error:
 * a resumed call whose run still waits for another call of the same step (Mastra marks a stream
 * suspended only when it sees a call suspend, and rejects the reason otherwise).
 */
export function parkedView<O extends Output>(
  output: O,
  voice: TurnVoice,
  opts: { resumed?: boolean } = {},
): O {
  // Read from the stream's own copy, whoever else reads it.
  const seen: Promise<Seen> = (async () => {
    const s: Seen = { parked: [], results: [], text: '', usage: {} };
    for await (const chunk of output.fullStream as AsyncIterable<Chunk>) {
      const call = parkedOf(chunk);
      if (call) s.parked.push(call);
      else if (chunk.type === 'tool-result') s.results.push(chunk);
      else if (chunk.type === 'text-delta') s.text += String(chunk.payload?.text ?? '');
      else if (chunk.type === 'finish' || chunk.type === 'error') s.ended = chunk.type;
      else if (chunk.type === 'step-finish') {
        const u = (chunk.payload?.output as { usage?: Usage } | undefined)?.usage;
        if (u)
          s.usage = {
            inputTokens: add(s.usage.inputTokens, u.inputTokens),
            outputTokens: add(s.usage.outputTokens, u.outputTokens),
            totalTokens: add(s.usage.totalTokens, u.totalTokens),
          };
      }
    }
    return s;
  })().catch((): Seen => ({ parked: [], results: [], text: '', usage: {}, ended: 'error' }));
  const fullStream = () => {
    let last: Chunk | undefined;
    const calls: SuspendedCall[] = [];
    return (output.fullStream as ReadableStream<Chunk>).pipeThrough(
      new TransformStream<Chunk, Chunk>({
        transform(chunk, controller) {
          last = chunk;
          const call = parkedOf(chunk);
          if (!call) return controller.enqueue(chunk);
          calls.push(call);
          controller.enqueue(resultChunk(call, chunk));
        },
        flush(controller) {
          if (!calls.length) return;
          const id = `parked-${calls[0].toolCallId}`;
          const base = { runId: last?.runId ?? '', from: last?.from ?? 'AGENT' };
          const text = waitingText('', calls, voice);
          controller.enqueue({ type: 'text-start', ...base, payload: { id } });
          controller.enqueue({ type: 'text-delta', ...base, payload: { id, text } });
          controller.enqueue({ type: 'text-end', ...base, payload: { id } });
          // A suspended stream ends without one; the client sees this turn end like any other.
          if (last?.type !== 'finish')
            controller.enqueue({
              type: 'finish',
              ...base,
              payload: {
                stepResult: { reason: 'stop' },
                output: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
                metadata: {},
                messages: { all: [], user: [], nonUser: [] },
              },
            });
        },
      }),
    );
  };
  const parkedResults = (s: Seen, runId: string | undefined) =>
    s.parked.map((c) => resultChunk(c, { runId }));
  const text = async () => {
    const [said, s] = await Promise.all([
      opts.resumed ? Promise.resolve('') : (output.text as Promise<string>),
      seen,
    ]);
    const words = opts.resumed ? s.text : said;
    return s.parked.length ? waitingText(words, s.parked, voice) : words;
  };
  const toolResults = async () => {
    const [done, s] = await Promise.all([
      opts.resumed ? Promise.resolve([]) : (output.toolResults as Promise<unknown[]>),
      seen,
    ]);
    return [...(opts.resumed ? s.results : done), ...parkedResults(s, output.runId)];
  };
  const totalUsage = async () => (opts.resumed ? (await seen).usage : output.totalUsage);
  const finishReason = async () => {
    try {
      return await output.finishReason;
    } catch (e) {
      const s = await seen;
      if (!s.ended) return 'suspended';
      throw e;
    }
  };
  const getFullOutput = async () => {
    const [full, s] = await Promise.all([output.getFullOutput(), seen]);
    if (!s.parked.length && !opts.resumed) return full;
    // What scorers read (`returnScorerData`, the evals): the waiting line as the reply too.
    const scoring = full.scoringData as { output?: unknown[] } | undefined;
    const said =
      s.parked.length && Array.isArray(scoring?.output)
        ? {
            scoringData: {
              ...scoring,
              output: [
                ...scoring.output,
                {
                  id: `parked-${s.parked[0].toolCallId}`,
                  role: 'assistant',
                  createdAt: new Date(),
                  content: {
                    format: 2,
                    parts: [{ type: 'text', text: waitingText('', s.parked, voice) }],
                  },
                },
              ],
            },
          }
        : {};
    return {
      ...full,
      ...said,
      text: await text(),
      toolResults: await toolResults(),
      ...(opts.resumed ? { totalUsage: s.usage } : {}),
    };
  };
  return new Proxy(output, {
    get(target, prop) {
      if (prop === 'fullStream') return fullStream();
      if (prop === 'text') return text();
      if (prop === 'toolResults') return toolResults();
      if (prop === 'totalUsage') return totalUsage();
      if (prop === 'finishReason') return finishReason();
      if (prop === 'getFullOutput') return getFullOutput;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The person's last words in a turn's input (for the language they wrote in). */
function lastUserText(messages: unknown): string {
  if (typeof messages === 'string') return messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

type RunOptions = { requestContext?: RequestContextLike; runId?: string } & Record<string, unknown>;

/** The turn's run id is Mastra's too: one id names the trace, the audit rows and the snapshot. */
const withRunId = (options: RunOptions | undefined): RunOptions => {
  const runId = options?.runId ?? (options?.requestContext?.get('runId') as string | undefined);
  return { ...options, ...(runId ? { runId } : {}) };
};

/**
 * The agent a turn runs on, durable: its run id is the turn's, and a run that suspended on parked
 * writes answers as a parked turn (`parkedView`). `generate` runs on `stream` and its full output,
 * so it sees every parked call of the turn, and throws a failed run's error as `generate` does.
 */
export function durableAgent(agent: Agent): Agent {
  const stream = async (messages: unknown, options?: RunOptions) => {
    const o = withRunId(options);
    // biome-ignore lint/suspicious/noExplicitAny: Mastra's overloads
    const output = await (agent.stream as any)(messages, o);
    return parkedView(output, voiceOf(o.requestContext, lastUserText(messages)));
  };
  const generate = async (messages: unknown, options?: RunOptions) => {
    const full = await (await stream(messages, options)).getFullOutput();
    if (full.error) throw full.error;
    return full;
  };
  return new Proxy(agent, {
    get(target, prop) {
      if (prop === 'stream') return stream;
      if (prop === 'generate') return generate;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A run suspended on one approval: the agent that ran it, the call, and what it parked. */
export type Suspension = {
  /** The agent's registration name (assistant, assistantInline, assistantText). */
  agent: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  parked: ParkedCall;
};

type Found = { toolCallId: string; toolName: string; agentId?: string; parked: ParkedCall };

/**
 * The suspended call in a run's snapshot that waits for this approval. Searched wherever Mastra
 * keeps a suspended step (a step, or one of several calls run together), by the payload the tool
 * suspended with.
 */
function findParked(node: unknown, approvalId: string, depth = 0): Found | undefined {
  if (!node || typeof node !== 'object' || depth > 12) return undefined;
  const o = node as Record<string, unknown>;
  const payload = o.suspendPayload as Record<string, unknown> | undefined;
  if (o.status === 'suspended' && payload && typeof payload === 'object') {
    const parked = payload.toolCallSuspended;
    if (
      isParkedCall(parked) &&
      parked.approvalId === approvalId &&
      typeof payload.toolCallId === 'string'
    )
      return {
        toolCallId: payload.toolCallId,
        toolName: String(payload.toolName ?? ''),
        agentId: typeof payload.__agentId === 'string' ? payload.__agentId : undefined,
        parked,
      };
  }
  for (const value of Object.values(o)) {
    const found = findParked(value, approvalId, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The run `runId`, if it is suspended waiting for `approvalId`, from Mastra's storage (it works
 * in any process, after a restart). Undefined when it is not: it never suspended (a call made
 * outside a chat turn), it was already resumed, or it is not stored yet.
 */
export async function findSuspension(
  mastra: Mastra,
  agents: Readonly<Record<string, Agent>>,
  a: { runId: string; approvalId: string },
): Promise<Suspension | undefined> {
  const store = await mastra.getStorage()?.getStore('workflows');
  const run = await store?.getWorkflowRunById({ runId: a.runId });
  if (!run) return undefined;
  let snapshot: unknown = run.snapshot;
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return undefined;
    }
  }
  const state = snapshot as { status?: string; context?: unknown } | null;
  if (state?.status !== 'suspended') return undefined;
  const found = findParked(state.context, a.approvalId);
  if (!found) return undefined;
  const entry = Object.entries(agents).find(([, agent]) => agent.id === found.agentId);
  if (!entry) return undefined;
  return {
    agent: entry[0],
    runId: a.runId,
    toolCallId: found.toolCallId,
    toolName: found.toolName,
    parked: found.parked,
  };
}

/**
 * Resume a suspended run with the decision of its approval: the tool answers with it, and the
 * model carries on from where it stopped, under the same run id. The output reads like a turn's
 * (`parkedView`): if the run parks again, it suspends again and says what waits.
 */
export async function resumeSuspension(
  agent: Agent,
  s: Suspension,
  decision: ResumeDecision,
  options: { requestContext: RequestContextLike; maxSteps?: number; text?: string },
) {
  // biome-ignore lint/suspicious/noExplicitAny: Mastra's overloads
  const output = await (agent.resumeStream as any)(decision, {
    runId: s.runId,
    toolCallId: s.toolCallId,
    requestContext: options.requestContext,
    maxSteps: options.maxSteps ?? 8,
  });
  return parkedView(output, voiceOf(options.requestContext, options.text), { resumed: true });
}
