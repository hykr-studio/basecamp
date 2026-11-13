import { randomUUID } from 'node:crypto';
import {
  type Channel,
  type ChatContext,
  type ChatResponse,
  isTimeZone,
  type Lang,
  lookupsIn,
  type Present,
  type Principal,
  type Surface,
  type ToolCallSummary,
} from '@hykr/contracts';
import { TenantConfigService, tenantZone } from '@hykr/core';
import { toolsFor } from '@hykr/core/tools';
import { englishName } from '@hykr/i18n';
import { subjectKeyOf, userIdOf } from '@hykr/policy';
import { RequestContext } from '@mastra/core/request-context';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { TurnInfo, TurnOutcome } from '../../hooks.js';
import { runtime } from '../../runtime.js';
import { type SavedPart, ThreadsService, threadOwnerOf } from '../threads/threads.service.js';
import { afterTurn, gateTurn, type TurnShape } from './turn-hooks.js';

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
 * approval, a refusal's reason), not the data. A list's rows are fetched again by its view. A
 * lookup (`lookupsIn`) shows nothing, so it keeps no view.
 */
function compact(result: RawToolResult['result'], lookup = false) {
  if (!result) return null;
  const { ok, present, speech, error } = result;
  const r = result.result;
  return {
    ok,
    ...(present && !lookup ? { present } : {}),
    ...(speech && !lookup ? { speech } : {}),
    ...(error ? { error: { reason: error.reason, message: error.message } } : {}),
    ...(r?.status ? { result: { status: r.status, approval: r.approval } } : {}),
  };
}

/** A tool result as Mastra hands it over: bare, or in a chunk's payload. */
const rawOf = (r: unknown) =>
  (r && typeof r === 'object' && 'payload' in r ? r.payload : r) as RawToolResult & {
    args?: unknown;
  };

/** The turn's lookups: reads whose view came before a write of the same turn (`lookupsIn`). */
const lookupsOf = (results: unknown[]) => lookupsIn(results.map((r) => rawOf(r).result));

/**
 * The reply's tool calls, as UI message parts, so a reloaded thread renders as the app showed it
 * once the turn was done: a lookup without its view.
 */
function partsOf(results: unknown[]): SavedPart[] {
  const lookups = lookupsOf(results);
  return results.map((r, i) => {
    const x = rawOf(r);
    return {
      type: `tool-${x.toolName ?? 'tool'}`,
      toolCallId: x.toolCallId ?? randomUUID(),
      state: 'output-available',
      input: x.args ?? {},
      output: compact(x.result, lookups.has(i)),
    };
  });
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

/**
 * What each tool call amounted to: "ok" only means the API answered. A lookup (a read the
 * assistant made to find what it then wrote) shows nothing: the write is the answer.
 */
export function summarize(results: unknown[]): ToolCallSummary[] {
  const lookups = lookupsOf(results);
  return results.map((r, i) => {
    const x = rawOf(r);
    const tool = String(x.toolName ?? 'tool');
    const shown = lookups.has(i)
      ? {}
      : {
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

/** A fresh run id that doubles as a trace id (32 hex chars). */
const newRunId = () => randomUUID().replaceAll('-', '');

/** What the turn hooks decided, where the agent reads it (assistant.ts). */
function applyShape(requestContext: RequestContext, shape: TurnShape) {
  if (shape.context.length) requestContext.set('turnContext', shape.context);
  if (shape.model) requestContext.set('model', shape.model);
  if (shape.withoutTools.length) requestContext.set('withoutTools', shape.withoutTools);
}

type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

/** A finished (or failed) turn, as the hooks' `after` sees it. */
const outcomeOf = (
  text: string,
  results: unknown[],
  usage: Usage,
  interrupted = false,
): TurnOutcome => ({
  text,
  toolCalls: summarize(results).map((c) => c.tool),
  ...(usage
    ? {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
      }
    : {}),
  interrupted,
});

/**
 * A person (or a relay acting for one) sends a message; the agent runs one turn for that
 * person. Its tool calls go back through the API under its own key, so every rule and audit
 * row applies. Every channel goes through here: the same agent, context, history, turn hooks
 * and logging.
 */
@Injectable()
export class ChatService implements OnApplicationBootstrap {
  constructor(
    private readonly threads: ThreadsService,
    private readonly tenants: TenantConfigService,
  ) {}

  /** The person's zone as the turn says it; else their business's (`tenantZone`). */
  private async zoneOf(given: string | undefined, tenantId: string): Promise<string> {
    if (isTimeZone(given)) return given;
    const business = await this.tenants.get(tenantId).catch(() => undefined);
    return tenantZone(business?.settings);
  }

  /**
   * Every tool the agent could get, built once: a tool id defined twice (a contribution named
   * like a generated tool) stops the start instead of one silently replacing the other.
   */
  onApplicationBootstrap() {
    const { catalog, registry } = runtime();
    const clientFor = () => {
      throw new Error('Tools built at startup are only checked, never called');
    };
    toolsFor({ clientFor, registry }, catalog, { canvas: true });
  }

  private async prepare(p: Principal, turn: Turn) {
    // Who the agent acts for comes from the server-side principal, never the request body.
    const subject = subjectOf(p);
    const channel: Channel = p.channel ?? 'app';
    const owner = threadOwnerOf(p);
    const thread = turn.threadId
      ? await this.threads.owned(turn.threadId, owner)
      : await this.threads.current(owner);
    // The run id doubles as the trace id (32 hex chars), so an audit row's run_id opens the
    // matching trace in Studio. A relay (voice) names the run it already started.
    const runId = p.runId ?? newRunId();
    const info: TurnInfo = {
      kind: 'chat',
      principal: p,
      runId,
      threadId: thread.id,
      message: turn.message,
      channel,
      surfaces: turn.surfaces,
      ...(turn.lang ? { lang: turn.lang } : {}),
    };
    // Before anything is saved: a refused turn leaves the thread as it was.
    const shape = await gateTurn(info);
    const history = await this.threads.history(thread.id, HISTORY - 1);
    await this.threads.append({
      threadId: thread.id,
      role: 'user',
      text: turn.message,
      channel,
      lang: turn.lang,
    });

    const requestContext = new RequestContext();
    // Whom the agent's tools act for, in which business: the API checks both again.
    requestContext.set('actingFor', subject);
    requestContext.set('tenantId', owner.tenantId);
    requestContext.set('userId', userIdOf(p) ?? subject);
    requestContext.set('runId', runId);
    requestContext.set('channel', channel);
    if (turn.lang) requestContext.set('lang', turn.lang);
    const timeZone = await this.zoneOf(turn.timeZone, owner.tenantId);
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
    applyShape(requestContext, shape);
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
    return {
      agent: runtime().agents.agentFor(turn.surfaces),
      messages,
      options,
      runId,
      threadId: thread.id,
      save,
      info,
    };
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
    runtime().agents.mastra.loggerVNext.info('chat turn', {
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
    const transcript = conversation
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Business'}: ${m.text}`)
      .join('\n');
    const message = `Draft a reply to this customer for the business to send. Write only the message, short and polite${lang ? `, in ${englishName(lang)}` : ''}.\n\n${transcript}`;
    // A draft spends tokens too: it passes the same hooks, with no thread.
    const info: TurnInfo = {
      kind: 'draft',
      principal: p,
      runId: newRunId(),
      message,
      channel: 'whatsapp',
      surfaces: ['text'],
      ...(lang ? { lang } : {}),
    };
    const shape = await gateTurn(info);
    const requestContext = new RequestContext();
    requestContext.set('actingFor', subjectOf(p));
    requestContext.set('tenantId', p.tenantId);
    requestContext.set('runId', info.runId);
    requestContext.set('channel', 'whatsapp');
    requestContext.set('surfaces', ['text']);
    if (lang) requestContext.set('lang', lang);
    applyShape(requestContext, shape);
    const result = await runtime()
      .agents.agentFor(['text'])
      .generate([{ role: 'user' as const, content: message }], {
        requestContext,
        maxSteps: 1,
        toolChoice: 'none',
      })
      .catch(async (e) => {
        await afterTurn(info, outcomeOf('', [], undefined, true));
        throw e;
      });
    await afterTurn(info, outcomeOf(result.text, [], result.totalUsage));
    return result.text.trim();
  }

  /** The whole turn as one JSON answer: tests, scripts and channels without streaming. */
  async once(p: Principal, turn: Turn): Promise<ChatResponse> {
    const { agent, messages, options, runId, threadId, save, info } = await this.prepare(p, turn);
    const started = Date.now();
    const result = await agent.generate(messages, options).catch(async (e) => {
      await save(INTERRUPTED, []).catch(() => {});
      await afterTurn(info, outcomeOf(INTERRUPTED, [], undefined, true));
      throw e;
    });
    const results = result.toolResults ?? [];
    await save(result.text, results);
    const toolCalls = summarize(results);
    this.record(p, runId, toolCalls, result.totalUsage?.totalTokens, started);
    await afterTurn(info, outcomeOf(result.text, results, result.totalUsage));
    return { reply: result.text, runId, threadId, toolCalls };
  }

  /**
   * The turn as it happens: Mastra's stream, for the caller to convert and send, and `saved`,
   * which settles once the reply is in the thread. The caller ends the response only after it,
   * so whoever reads the thread next (the app reloading, the next voice turn) finds the reply.
   */
  async stream(p: Principal, turn: Turn, abortSignal?: AbortSignal) {
    const { agent, messages, options, runId, threadId, save, info } = await this.prepare(p, turn);
    const started = Date.now();
    const output = await agent.stream(messages, { ...options, abortSignal });
    const saved = Promise.all([output.text, output.toolResults, output.totalUsage])
      .then(async ([text, results, usage]) => {
        await save(text, results);
        this.record(p, runId, summarize(results), usage?.totalTokens, started);
        await afterTurn(info, outcomeOf(text, results, usage));
      })
      .catch(async (e) => {
        // Failed or cut off: the thread still says so, rather than two questions in a row.
        log.warn(`run=${runId} interrupted: ${e instanceof Error ? e.message : e}`);
        await save(INTERRUPTED, []).catch(() => {});
        await afterTurn(info, outcomeOf(INTERRUPTED, [], undefined, true));
      });
    return { output, runId, threadId, saved };
  }
}
