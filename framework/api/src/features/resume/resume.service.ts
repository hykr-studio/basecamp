import { randomUUID } from 'node:crypto';
import { AGENT_ID, type Suspension } from '@hykr/agents';
import { render } from '@hykr/channels';
import {
  type Channel,
  type ChatResponse,
  type DomainEventEnvelope,
  type Principal,
  parseSubjectKey,
  type Subject,
  type Surface,
} from '@hykr/contracts';
import { type NamedEvent, PrincipalResolver, recordEvents } from '@hykr/core';
import type { ResumeDecision } from '@hykr/core/tools';
import { type Database, schema } from '@hykr/db';
import { isLang, type Lang, pick, t } from '@hykr/i18n';
import { RequestContext } from '@mastra/core/request-context';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DelayedError, type Job } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { ContactsService } from '../../channels/contacts.service.js';
import { OutboundService } from '../../channels/outbound.service.js';
import { toRenderTurn } from '../../channels/whatsapp/turn.js';
import { config } from '../../config.js';
import type { TurnInfo, TurnOutcome } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { summarize } from '../../modules/chat/chat.service.js';
import { afterTurn, gateTurn, TurnRefused } from '../../modules/chat/turn-hooks.js';
import { ThreadsService } from '../../modules/threads/threads.service.js';
import { runtime } from '../../runtime.js';
import { partsOf } from './parts.js';

const { approvals, threads, threadMessages, contacts } = schema;
type ApprovalRow = typeof approvals.$inferSelect;

const log = new Logger('Resume');

/** How long after a request the run's reply may still be on its way to the thread. */
const SAVING_MS = 2 * 60_000;

/** Saved in place of a continuation that failed, as the chat service does for a turn. */
const INTERRUPTED = '(The reply was interrupted.)';

const DECIDED = new Set(['approved', 'rejected', 'expired', 'failed']);

/** Reads of the stored run after a resume, 100 ms apart, before the next resume may start. */
const SNAPSHOT_TRIES = 50;

/** How long one resume may hold its run (a resume runs at most 8 model steps). */
const LOCK_MS = 10 * 60_000;

/** Delete the lock only if this resume still holds it. */
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/** Thrown to retry the job later: the run's turn may still be saving its reply. */
export class RunNotSaved extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is not in a thread yet`);
    this.name = 'RunNotSaved';
  }
}

/** Another decision of the same run is being resumed now (outside a queue job). */
export class RunBusy extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is being resumed`);
    this.name = 'RunBusy';
  }
}

/** How a run went on: it ran (and may wait again), a turn hook refused it, or it failed. */
export type ContinuedOutcome = 'resumed' | 'refused' | 'failed';

/**
 * A thread changed outside a turn (a run went on): live updates tell its owner to reload it, and
 * the agents feature closes the run in its log (A6).
 */
class ThreadContinued implements NamedEvent {
  readonly eventName = 'thread.continued';
  readonly resourceType = 'thread';
  constructor(
    readonly row: { id: string; messageId: string; runId: string; outcome: ContinuedOutcome },
  ) {}
}

/** Is the subject the one who asked for this approval? */
function isRequester(row: ApprovalRow, subject: Subject) {
  return subject.kind === 'user'
    ? row.ownerId === subject.userId
    : row.requesterContactId === subject.contactId;
}

/** What the person hears when the model said nothing: how the request was decided. */
function decidedLine(lang: Lang, d: ResumeDecision) {
  const summary = d.summary ?? t(lang, 'said.aChange');
  if (d.status === 'approved') return t(lang, 'run.approved', { summary });
  if (d.status === 'rejected') return t(lang, 'run.rejected', { summary });
  if (d.status === 'expired') return t(lang, 'run.expired', { summary });
  return t(lang, 'run.failed', { reason: d.reason ?? summary });
}

type RunThread = {
  threadId: string;
  channel: Channel;
  lang: Lang | null;
  ownerId: string | null;
  contactId: string | null;
  /** What the person asked in the turn that parked. */
  message: string;
};

/**
 * Durable runs, the second half: when a request an assistant's run waits for is decided, the run
 * goes on. The stored `approval.decided` event reaches `resume.approvals` in the worker, which
 * queues it on `agent-resume`; this finds the suspended run, checks it, passes the turn hooks,
 * resumes it with the decision, appends what it says to the person's thread, and tells them
 * (WhatsApp when the run came from there, a live event for the app). docs/decisions/A7.md.
 */
@Injectable()
export class ResumeService implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly threads: ThreadsService,
    private readonly resolver: PrincipalResolver,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {}

  /** The lock client, opened on first use (the queues keep their own connections). */
  private redis: Redis | undefined;

  async onApplicationShutdown() {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }

  /**
   * One decided approval: resume the run it belongs to, if one waits. Returns what happened.
   * `job`: the queue's job, put back for a second while another decision of the same run is
   * being resumed (without one, that throws `RunBusy`).
   */
  async onDecided(event: DomainEventEnvelope, job?: Job): Promise<string> {
    if (event.resourceType !== 'approval' || !event.resourceId) return 'not an approval';
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, event.resourceId), eq(approvals.tenantId, event.tenantId)));
    if (!row?.runId || !DECIDED.has(row.status)) return 'nothing to resume';
    const runId = row.runId;
    // One resume of a run at a time: two requests of one run decided together go in turn, each
    // then finding its own call in the run as the other left it. A Redis lock, not a database
    // one: no transaction may stay open while the model runs (Mastra's first use of its storage
    // builds indexes concurrently, which waits for every open transaction).
    this.redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    const key = `${config.queuePrefix}:resume:lock:${runId}`;
    const holder = `${job?.id ?? 'direct'}:${randomUUID()}`;
    if (!(await this.redis.set(key, holder, 'PX', LOCK_MS, 'NX'))) {
      if (!job) throw new RunBusy(runId);
      // Not a failure: it comes back once the other resume is done (no try is spent).
      await job.moveToDelayed(Date.now() + 1000, job.token);
      throw new DelayedError();
    }
    try {
      return await this.resumeLocked(row, runId);
    } finally {
      await this.redis.eval(UNLOCK, 1, key, holder).catch(() => {});
    }
  }

  private async resumeLocked(row: ApprovalRow, runId: string): Promise<string> {
    const agents = runtime().agents;
    // Mastra stores a run only when it suspends, which it does as the write parks: no stored run
    // waiting for this request means it never suspended (a call made outside a chat turn), or it
    // was resumed already.
    const s = await agents.findSuspension({ runId, approvalId: row.id });
    if (!s) return 'not suspended';
    const thread = await this.threadOf(runId, row.tenantId);
    if (!thread) {
      // The turn that parked saves its reply when it ends: it may be ending now.
      if (Date.now() - row.createdAt.getTime() < SAVING_MS) throw new RunNotSaved(runId);
      log.warn(`run=${runId} approval=${row.id}: no conversation holds this run; not resumed`);
      return 'no thread';
    }
    const why = this.refusal(row, s, thread);
    if (why) {
      log.warn(`run=${runId} approval=${row.id}: not resumed (${why})`);
      return why;
    }
    const ctx = s.parked.context;
    const channel = (ctx.channel as Channel | undefined) ?? thread.channel;
    let p: Principal;
    try {
      const standing = await this.resolver.forActingFor(ctx.actingFor, {
        tenantId: row.tenantId,
        channel,
      });
      p = {
        actor: { kind: 'agent', id: AGENT_ID },
        ...standing,
        ...(standing.subject.kind === 'user'
          ? { actingFor: { userId: standing.subject.userId } }
          : { actingFor: { contactId: standing.subject.contactId } }),
        scopes: [],
        channel,
        runId,
      };
    } catch (e) {
      log.warn(`run=${runId}: the person is no longer here (${(e as Error).message})`);
      return 'not a member';
    }
    const lang: Lang = isLang(ctx.lang) ? ctx.lang : (thread.lang ?? 'en');
    const surfaces = (ctx.surfaces ?? ['text']) as Surface[];
    const info: TurnInfo = {
      kind: 'resume',
      principal: p,
      runId,
      threadId: thread.threadId,
      message: thread.message,
      channel,
      surfaces,
      ...(isLang(ctx.lang) ? { lang: ctx.lang } : {}),
    };
    const decision: ResumeDecision = {
      approvalId: row.id,
      status: row.status as ResumeDecision['status'],
      reason: row.failureReason,
      summary: row.summary,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };

    // A resume spends tokens like a turn: the same hooks (credits, the model policy) decide.
    let shape: Awaited<ReturnType<typeof gateTurn>>;
    try {
      shape = await gateTurn(info);
    } catch (e) {
      if (!(e instanceof TurnRefused)) throw e;
      const { say, reason } = e.refusal;
      const text = say ? pick(say, lang) : t(lang, 'run.couldNotContinue', { reason });
      await this.say(p, thread, runId, lang, { reply: text, results: [] }, 'refused');
      return `refused: ${e.refusal.rule}`;
    }

    const requestContext = new RequestContext();
    requestContext.set('actingFor', ctx.actingFor);
    requestContext.set('tenantId', row.tenantId);
    requestContext.set(
      'userId',
      ctx.userId ?? (p.subject?.kind === 'user' ? p.subject.userId : ctx.actingFor),
    );
    requestContext.set('runId', runId);
    requestContext.set('channel', channel);
    if (isLang(ctx.lang)) requestContext.set('lang', ctx.lang);
    const timeZone = validTimeZone(ctx.timeZone);
    requestContext.set('timeZone', timeZone);
    requestContext.set('today', new Date().toLocaleDateString('sv', { timeZone }));
    requestContext.set('surfaces', surfaces);
    if (ctx.screen) requestContext.set('screen', ctx.screen);
    if (ctx.record) requestContext.set('record', ctx.record);
    // A business's agent (A6): its tools carry on with the run's token, not the assistant's key.
    if (ctx.agent) requestContext.set('agent', ctx.agent);
    if (shape.context.length) requestContext.set('turnContext', shape.context);
    if (shape.model) requestContext.set('model', shape.model);
    if (shape.withoutTools.length) requestContext.set('withoutTools', shape.withoutTools);

    const started = Date.now();
    let text: string;
    let results: unknown[];
    let usage: TurnOutcome['usage'];
    let finish: string | undefined;
    try {
      const out = await agents.resume(s, decision, {
        requestContext,
        maxSteps: 8,
        text: thread.message,
      });
      [text, results, usage, finish] = await Promise.all([
        out.text,
        out.toolResults as Promise<unknown[]>,
        out.totalUsage,
        out.finishReason,
      ]);
      // The next decision of this run (waiting for the lock) must find the run as this one left
      // it: Mastra may still be writing the snapshot when the stream ends.
      await this.stored(runId, row.id);
    } catch (e) {
      log.warn(`run=${runId} resume failed: ${e instanceof Error ? e.message : e}`);
      await this.say(p, thread, runId, lang, { reply: INTERRUPTED, results: [] }, 'failed').catch(
        () => {},
      );
      await afterTurn(info, { text: INTERRUPTED, toolCalls: [], interrupted: true });
      return 'failed';
    }
    const outcome: TurnOutcome = {
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
      interrupted: false,
    };
    // Another call of the same run still waits, and nothing new was said: the run goes on when
    // that one is decided.
    if (finish === 'suspended' && !text.trim() && !results.length) {
      await afterTurn(info, outcome);
      return 'still waiting';
    }
    const reply = text.trim() || decidedLine(lang, decision);
    await this.say(p, thread, runId, lang, { reply, results }, 'resumed');
    await afterTurn(info, { ...outcome, text: reply });
    log.log(
      `run=${runId} resumed after approval=${row.id} (${row.status}) tools=[${outcome.toolCalls.join(',')}] ${Date.now() - started}ms`,
    );
    return 'resumed';
  }

  /** Wait (a few seconds at most) until the stored run no longer waits for this approval. */
  private async stored(runId: string, approvalId: string) {
    const agents = runtime().agents;
    for (let i = 0; i < SNAPSHOT_TRIES; i++) {
      if (!(await agents.findSuspension({ runId, approvalId }))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    log.warn(`run=${runId}: the stored run still waits for approval=${approvalId} after resuming`);
  }

  /** Why this suspension must not be resumed for this approval, or null. Fails closed. */
  private refusal(row: ApprovalRow, s: Suspension, thread: RunThread): string | null {
    const ctx = s.parked.context;
    if (ctx.tenantId && ctx.tenantId !== row.tenantId) return 'another business';
    const subject = parseSubjectKey(ctx.actingFor);
    if (!subject || !isRequester(row, subject)) return 'another requester';
    const owns =
      subject.kind === 'user'
        ? thread.ownerId === subject.userId
        : thread.contactId === subject.contactId;
    return owns ? null : 'another conversation';
  }

  /**
   * The thread that holds the run's reply (its first), in this business, with who owns it and
   * what the person asked just before.
   */
  private async threadOf(runId: string, tenantId: string): Promise<RunThread | undefined> {
    const [reply] = await this.db
      .select({
        threadId: threadMessages.threadId,
        seq: threadMessages.seq,
        channel: threadMessages.channel,
        lang: threadMessages.lang,
        ownerId: threads.ownerId,
        contactId: threads.contactId,
      })
      .from(threadMessages)
      .innerJoin(threads, eq(threads.id, threadMessages.threadId))
      .where(
        and(
          eq(threadMessages.runId, runId),
          eq(threadMessages.role, 'assistant'),
          eq(threads.tenantId, tenantId),
        ),
      )
      .orderBy(asc(threadMessages.seq))
      .limit(1);
    if (!reply) return undefined;
    const asked = await this.db
      .select({ text: threadMessages.text, seq: threadMessages.seq })
      .from(threadMessages)
      .where(and(eq(threadMessages.threadId, reply.threadId), eq(threadMessages.role, 'user')))
      .orderBy(asc(threadMessages.seq));
    const message = asked.filter((m) => m.seq < reply.seq).at(-1)?.text ?? '';
    return {
      threadId: reply.threadId,
      channel: reply.channel as Channel,
      lang: isLang(reply.lang) ? reply.lang : null,
      ownerId: reply.ownerId,
      contactId: reply.contactId,
      message,
    };
  }

  /**
   * The continuation, in the thread, and where the person is: a live event (the app reloads the
   * thread) and, for a run that came in on WhatsApp, a message to their number while the
   * conversation's 24 hours are open.
   */
  private async say(
    p: Principal,
    thread: RunThread,
    runId: string,
    lang: Lang,
    turn: { reply: string; results: unknown[] },
    outcome: ContinuedOutcome,
  ) {
    const saved = await this.threads.append({
      threadId: thread.threadId,
      role: 'assistant',
      text: turn.reply,
      parts: partsOf(turn.results),
      channel: thread.channel,
      lang,
      runId,
    });
    await this.db.transaction((tx) =>
      recordEvents(tx, {
        principal: p,
        requestId: `resume:${runId}`,
        events: [new ThreadContinued({ id: thread.threadId, messageId: saved.id, runId, outcome })],
      }),
    );
    if (thread.channel === 'whatsapp')
      await this.toWhatsApp(p, runId, lang, {
        reply: turn.reply,
        runId,
        threadId: thread.threadId,
        toolCalls: summarize(turn.results),
      });
  }

  private async toWhatsApp(p: Principal, runId: string, lang: Lang, turn: ChatResponse) {
    const tenantId = p.tenantId;
    const subject = p.subject;
    if (!tenantId || !subject) return;
    const contactsSvc = this.ref.get(ContactsService, { strict: false });
    const outbound = this.ref.get(OutboundService, { strict: false });
    const [contact] = await this.db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          subject.kind === 'contact'
            ? eq(contacts.id, subject.contactId)
            : eq(contacts.userId, subject.userId),
        ),
      )
      .limit(1);
    if (!contact) return;
    // Free-form messages only inside the 24-hour window; outside it, the thread keeps it.
    if (!(await contactsSvc.windowOpen(contact.id))) {
      log.log(`run=${runId}: the WhatsApp window is closed; the continuation stays in the thread`);
      return;
    }
    const from = await contactsSvc.numberOfTenant(tenantId);
    if (!from) return;
    // A request the continuation parks again is approved in the app (no buttons here).
    const messages = render(toRenderTurn(turn), {
      to: contact.address,
      lang,
      appUrl: config.appUrl,
    });
    await outbound.queue({ tenantId, contactId: contact.id, from }, messages, { runId });
  }
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
