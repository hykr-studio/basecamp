import { randomUUID } from 'node:crypto';
import { agentFor, mastra } from '@app/agents';
import type {
  Channel,
  ChatContext,
  ChatResponse,
  Lang,
  Present,
  Principal,
  Surface,
  ToolCallSummary,
} from '@app/contracts';
import { LANG_ENGLISH_NAMES } from '@app/i18n';
import { subjectKeyOf, userIdOf } from '@app/policy';
import { RequestContext } from '@mastra/core/request-context';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { type SavedPart, ThreadsService, threadOwnerOf } from '../threads/threads.service.js';

/** One turn's input, whatever the channel: the app's stream, a JSON caller, WhatsApp, voice. */
export type Turn = {
  /** The thread to continue; omitted, the person's current thread. */
  threadId?: string;
  message: string;
  context?: ChatContext;
  timeZone?: string;
  surfaces: Surface[];
  /** The language to answer in (voice sessions pin or detect it). */
  lang?: Lang;
};

/** How many saved messages the model reads as history. */
const HISTORY = 12;

/** Whom a turn is for ("user:<id>" or "contact:<id>"): the caller, or whom a relay acts for. */
const subjectOf = (p: Principal) => subjectKeyOf(p) ?? `agent:${p.actor.id}`;

/** Saved in place of a reply that failed or was cut off, so the thread says what happened. */
const INTERRUPTED = '(The reply was interrupted.)';

/**
 * What a tool result keeps once saved: what the chat renders (the outcome, what it showed, an
 * approval, a refusal's reason), not the data. A list's rows are fetched again by its view.
 */
function compact(result: RawToolResult['result']) {
  if (!result) return null;
  const { ok, present, speech, error } = result;
  const r = result.result;
  return {
    ok,
    ...(present ? { present } : {}),
    ...(speech ? { speech } : {}),
    ...(error ? { error: { reason: error.reason, message: error.message } } : {}),
    ...(r?.status ? { result: { status: r.status, approval: r.approval } } : {}),
  };
}

/** The reply's tool calls, as UI message parts, so a reloaded thread renders as it streamed. */
function partsOf(results: unknown[]): SavedPart[] {
  return results.map((r) => {
    const x = (r && typeof r === 'object' && 'payload' in r ? r.payload : r) as RawToolResult & {
      args?: unknown;
    };
    return {
      type: `tool-${x.toolName ?? 'tool'}`,
      toolCallId: x.toolCallId ?? randomUUID(),
      state: 'output-available',
      input: x.args ?? {},
      output: compact(x.result),
    };
  });
}

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
    speech?: string;
    result?: { status?: string; approval?: { id?: string; summary?: string | null } };
    error?: { reason?: string; message?: unknown } | null;
  };
};

/** What each tool call amounted to: "ok" only means the API answered. */
export function summarize(results: unknown[]): ToolCallSummary[] {
  return results.map((r) => {
    const x = (r && typeof r === 'object' && 'payload' in r ? r.payload : r) as RawToolResult;
    const tool = String(x.toolName ?? 'tool');
    const shown = {
      ...(x.result?.present ? { present: x.result.present } : {}),
      ...(x.result?.speech ? { speech: x.result.speech } : {}),
    };
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
        ...shown,
      };
    }
    return { tool, ok: true, outcome: 'done', ...shown };
  });
}

const log = new Logger('Chat');

/**
 * A person (or a relay acting for one) sends a message; the agent runs one turn for that
 * person. Its tool calls go back through the API under its own key, so every rule and audit
 * row applies. Every channel goes through here: the same agent, context, history and logging.
 */
@Injectable()
export class ChatService {
  constructor(private readonly threads: ThreadsService) {}

  private async prepare(p: Principal, turn: Turn) {
    if (process.env.MODEL_MODE !== 'fake' && !process.env.OPENROUTER_API_KEY) {
      throw new ServiceUnavailableException('Set OPENROUTER_API_KEY in .env to use the assistant');
    }
    // Who the agent acts for comes from the server-side principal, never the request body.
    const subject = subjectOf(p);
    const channel: Channel = p.channel ?? 'app';
    const owner = threadOwnerOf(p);
    const thread = turn.threadId
      ? await this.threads.owned(turn.threadId, owner)
      : await this.threads.current(owner);
    const history = await this.threads.history(thread.id, HISTORY - 1);
    await this.threads.append({
      threadId: thread.id,
      role: 'user',
      text: turn.message,
      channel,
      lang: turn.lang,
    });

    // The run id doubles as the trace id (32 hex chars), so an audit row's run_id opens the
    // matching trace in Studio. A relay (voice) names the run it already started.
    const runId = p.runId ?? randomUUID().replaceAll('-', '');
    const requestContext = new RequestContext();
    // Whom the agent's tools act for, in which business: the API checks both again.
    requestContext.set('actingFor', subject);
    requestContext.set('tenantId', owner.tenantId);
    requestContext.set('userId', userIdOf(p) ?? subject);
    requestContext.set('runId', runId);
    requestContext.set('channel', channel);
    if (turn.lang) requestContext.set('lang', turn.lang);
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
    const messages = [...history, { role: 'user' as const, text: turn.message }].map((m) =>
      m.role === 'user'
        ? { role: 'user' as const, content: m.text }
        : { role: 'assistant' as const, content: m.text },
    );
    const options = {
      requestContext,
      maxSteps: 8,
      tracingOptions: { traceId: runId, metadata: { subject, channel } },
    };
    const save = (text: string, results: unknown[]) =>
      this.threads.append({
        threadId: thread.id,
        role: 'assistant',
        text,
        parts: partsOf(results),
        channel,
        lang: turn.lang,
        runId,
      });
    return { agent: agentFor(turn.surfaces), messages, options, runId, threadId: thread.id, save };
  }

  private record(
    p: Principal,
    runId: string,
    toolCalls: ToolCallSummary[],
    tokens: unknown,
    started: number,
  ) {
    const subject = subjectOf(p);
    const channel = p.channel ?? 'app';
    // One line per turn: in this terminal, and in Studio → Logs (run = trace id).
    mastra.loggerVNext.info('chat turn', {
      runId,
      subject,
      channel,
      tools: toolCalls,
      tokens,
      ms: Date.now() - started,
    });
    log.log(
      `run=${runId} for=${subject} channel=${channel} tools=[${toolCalls
        .map((c) => `${c.tool}:${c.outcome}`)
        .join(',')}] tokens=${tokens ?? '?'} ${Date.now() - started}ms`,
    );
  }

  /**
   * A reply for staff to edit and send (the back office): words only, no tools, nothing saved
   * to any thread. The conversation is the customer's, as the thread holds it.
   */
  async draft(
    p: Principal,
    conversation: { role: string; text: string }[],
    lang?: Lang,
  ): Promise<string> {
    const requestContext = new RequestContext();
    requestContext.set('actingFor', subjectOf(p));
    requestContext.set('tenantId', p.tenantId);
    requestContext.set('channel', 'whatsapp');
    requestContext.set('surfaces', ['text']);
    if (lang) requestContext.set('lang', lang);
    const transcript = conversation
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Business'}: ${m.text}`)
      .join('\n');
    const result = await agentFor(['text']).generate(
      [
        {
          role: 'user' as const,
          content: `Draft a reply to this customer for the business to send. Write only the message, short and polite${lang ? `, in ${LANG_ENGLISH_NAMES[lang]}` : ''}.\n\n${transcript}`,
        },
      ],
      { requestContext, maxSteps: 1, toolChoice: 'none' },
    );
    return result.text.trim();
  }

  /** The whole turn as one JSON answer: tests, scripts and channels without streaming. */
  async once(p: Principal, turn: Turn): Promise<ChatResponse> {
    const { agent, messages, options, runId, threadId, save } = await this.prepare(p, turn);
    const started = Date.now();
    const result = await agent.generate(messages, options).catch(async (e) => {
      await save(INTERRUPTED, []).catch(() => {});
      throw e;
    });
    const results = result.toolResults ?? [];
    await save(result.text, results);
    const toolCalls = summarize(results);
    this.record(p, runId, toolCalls, result.totalUsage?.totalTokens, started);
    return { reply: result.text, runId, threadId, toolCalls };
  }

  /**
   * The turn as it happens: Mastra's stream, for the caller to convert and send, and `saved`,
   * which settles once the reply is in the thread. The caller ends the response only after it,
   * so whoever reads the thread next (the app reloading, the next voice turn) finds the reply.
   */
  async stream(p: Principal, turn: Turn, abortSignal?: AbortSignal) {
    const { agent, messages, options, runId, threadId, save } = await this.prepare(p, turn);
    const started = Date.now();
    const output = await agent.stream(messages, { ...options, abortSignal });
    const saved = Promise.all([output.text, output.toolResults, output.totalUsage])
      .then(async ([text, results, usage]) => {
        await save(text, results);
        this.record(p, runId, summarize(results), usage?.totalTokens, started);
      })
      .catch(async (e) => {
        // Failed or cut off: the thread still says so, rather than two questions in a row.
        log.warn(`run=${runId} interrupted: ${e instanceof Error ? e.message : e}`);
        await save(INTERRUPTED, []).catch(() => {});
      });
    return { output, runId, threadId, saved };
  }
}
