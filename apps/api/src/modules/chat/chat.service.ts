import { randomUUID } from 'node:crypto';
import { agentFor, mastra } from '@app/agents';
import type {
  ChatContext,
  ChatResponse,
  Present,
  Principal,
  Surface,
  ToolCallSummary,
} from '@app/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** One turn's input, whatever the channel: the app's stream, a JSON caller, WhatsApp. */
export type Turn = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  context?: ChatContext;
  timeZone?: string;
  surfaces: Surface[];
};

/** The server keeps no chat memory: each turn carries its recent history. */
const HISTORY = 12;

function validTimeZone(zone: string | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

type RawToolResult = {
  toolName?: string;
  toolCallId?: string;
  result?: {
    ok?: boolean;
    present?: Present;
    result?: { status?: string; approval?: { id?: string; summary?: string | null } };
    error?: { reason?: string; message?: unknown } | null;
  };
};

/** What each tool call amounted to: "ok" only means the API answered. */
export function summarize(results: unknown[]): ToolCallSummary[] {
  return results.map((r) => {
    const x = (r && typeof r === 'object' && 'payload' in r ? r.payload : r) as RawToolResult;
    const tool = String(x.toolName ?? 'tool');
    const present = x.result?.present ? { present: x.result.present } : {};
    if (x.result?.ok === false) {
      const reason = x.result.error?.reason ?? x.result.error?.message;
      return {
        tool,
        ok: false,
        outcome: 'refused',
        ...(typeof reason === 'string' ? { detail: reason } : {}),
      };
    }
    if (x.result?.result?.status === 'needs_approval') {
      const { summary, id } = x.result.result.approval ?? {};
      return {
        tool,
        ok: true,
        outcome: 'parked',
        ...(summary ? { detail: summary } : {}),
        ...(id ? { approvalId: id } : {}),
        ...present,
      };
    }
    return { tool, ok: true, outcome: 'done', ...present };
  });
}

const log = new Logger('Chat');

/**
 * A person sends messages; the agent runs one turn acting for that person. Its tool calls
 * go back through the API under its own key, so every rule and audit row applies. Every
 * channel goes through here, so they all get the same agent, context and logging.
 */
@Injectable()
export class ChatService {
  private prepare(p: Principal, turn: Turn) {
    if (process.env.MODEL_MODE !== 'fake' && !process.env.OPENROUTER_API_KEY) {
      throw new ServiceUnavailableException('Set OPENROUTER_API_KEY in .env to use the assistant');
    }
    // Who the agent acts for comes from the server-side principal, never the request body.
    // The run id doubles as the trace id (32 hex chars), so an audit row's run_id opens the
    // matching trace in Studio.
    const runId = randomUUID().replaceAll('-', '');
    const requestContext = new RequestContext();
    requestContext.set('userId', p.actor.id);
    requestContext.set('runId', runId);
    const timeZone = validTimeZone(turn.timeZone);
    requestContext.set('timeZone', timeZone);
    requestContext.set('today', new Date().toLocaleDateString('sv', { timeZone }));
    requestContext.set('surfaces', turn.surfaces);
    // Where the person is: a hint only. Tools still load through the owner scope, so a
    // forged id finds nothing.
    if (turn.context) {
      requestContext.set('screen', turn.context.screen);
      if (turn.context.record) requestContext.set('record', turn.context.record);
      if (turn.context.canvas) requestContext.set('canvas', turn.context.canvas);
    }
    // Literal roles: Mastra's message types reject a plain 'user' | 'assistant' union.
    const messages = turn.messages
      .slice(-HISTORY)
      .map((m) =>
        m.role === 'user'
          ? { role: 'user' as const, content: m.content }
          : { role: 'assistant' as const, content: m.content },
      );
    const options = {
      requestContext,
      maxSteps: 8,
      tracingOptions: { traceId: runId, metadata: { userId: p.actor.id } },
    };
    return { agent: agentFor(turn.surfaces), messages, options, runId };
  }

  private record(
    p: Principal,
    runId: string,
    toolCalls: ToolCallSummary[],
    tokens: unknown,
    started: number,
  ) {
    // One line per turn: in this terminal, and in Studio → Logs (run = trace id).
    mastra.loggerVNext.info('chat turn', {
      runId,
      userId: p.actor.id,
      tools: toolCalls,
      tokens,
      ms: Date.now() - started,
    });
    log.log(
      `run=${runId} user=${p.actor.id} tools=[${toolCalls
        .map((c) => `${c.tool}:${c.outcome}`)
        .join(',')}] tokens=${tokens ?? '?'} ${Date.now() - started}ms`,
    );
  }

  /** The whole turn as one JSON answer: tests, scripts and channels without streaming. */
  async once(p: Principal, turn: Turn): Promise<ChatResponse> {
    const { agent, messages, options, runId } = this.prepare(p, turn);
    const started = Date.now();
    const result = await agent.generate(messages, options);
    const toolCalls = summarize(result.toolResults ?? []);
    this.record(p, runId, toolCalls, result.totalUsage?.totalTokens, started);
    return { reply: result.text, runId, toolCalls };
  }

  /** The turn as it happens: Mastra's stream, for the caller to convert and send. */
  async stream(p: Principal, turn: Turn, abortSignal?: AbortSignal) {
    const { agent, messages, options, runId } = this.prepare(p, turn);
    const started = Date.now();
    const output = await agent.stream(messages, { ...options, abortSignal });
    // Logged once the turn ends; a dropped connection just ends it early.
    Promise.all([output.toolResults, output.totalUsage])
      .then(([results, usage]) =>
        this.record(p, runId, summarize(results), usage?.totalTokens, started),
      )
      .catch(() => undefined);
    return { output, runId };
  }
}
