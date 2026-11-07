import {
  type CallInfo,
  type CallProviderInfo,
  CallsCapabilities,
  type Principal,
} from '@hykr/contracts';
import { entityDef, runWrite, systemPrincipal } from '@hykr/core';
import { callLogs, type Database } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Jobs } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { openConnection } from '../integrations/credentials.js';
import {
  aboutOf,
  type CallRow,
  callDialOutcome,
  type DialOutcome,
  presentCall,
  providerFor,
  reachableCall,
  registerCallOps,
} from './commands.js';
import { telephonyProviders } from './registry.js';

const log = new Logger('Calls');

export const DIAL_QUEUE = 'calls.dial';
export type DialJob = { callId: string };

const LIST_LIMIT = 100;

@Injectable()
export class CallsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: Jobs,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  onModuleInit() {
    registerCallOps();
  }

  async get(p: Principal, id: string) {
    return presentCall(await reachableCall(this.db, p, id), p);
  }

  /**
   * A record's calls (whoever reads the record), or else the calls about no record the person
   * may see: their own, or all of them with `calls.read_all`. Newest first.
   */
  async list(p: Principal, q: { entity?: string; id?: string }): Promise<CallInfo[]> {
    const tenantId = p.tenantId ?? '';
    let rows: CallRow[];
    if (q.entity || q.id) {
      const about = await aboutOf(this.db, p, q.entity, q.id);
      rows = await this.db
        .select()
        .from(callLogs)
        .where(
          and(
            eq(callLogs.tenantId, tenantId),
            eq(callLogs.resourceType, about?.entity ?? ''),
            eq(callLogs.resourceId, about?.id ?? ''),
          ),
        )
        .orderBy(desc(callLogs.createdAt))
        .limit(LIST_LIMIT);
    } else {
      const s = subjectOf(p);
      const me = s?.kind === 'user' ? s.userId : null;
      const all = can(p, CallsCapabilities.readAll);
      rows = await this.db
        .select()
        .from(callLogs)
        .where(
          and(
            eq(callLogs.tenantId, tenantId),
            isNull(callLogs.resourceType),
            all
              ? sql`true`
              : me
                ? or(eq(callLogs.loggedBy, me), eq(callLogs.userId, me))
                : sql`false`,
          ),
        )
        .orderBy(desc(callLogs.createdAt))
        .limit(LIST_LIMIT);
    }
    return rows.map((r) => presentCall(r, p) as unknown as CallInfo);
  }

  /** Whether the person's business can place calls now (`call.dial` decides who may). */
  async provider(p: Principal): Promise<CallProviderInfo> {
    const found = p.tenantId ? await providerFor(this.db, p.tenantId) : null;
    return { available: !!found, name: found?.provider.name ?? null };
  }

  queueDial(callId: string, eventId: string) {
    return this.jobs.add<DialJob>(
      DIAL_QUEUE,
      { callId },
      { name: 'dial', jobId: `calls-dial--${eventId}` },
    );
  }

  /**
   * In the worker: ask the call's provider to connect it, once. Each step (taken, placed,
   * failed) is a write as the business's system principal: audited on the call, with its
   * `call.updated` stored.
   */
  async dial(callId: string): Promise<string> {
    const [call] = await this.db.select().from(callLogs).where(eq(callLogs.id, callId));
    if (call?.status !== 'requested') return 'not requested';
    const outcome = (input: Omit<DialOutcome, 'callId'>) =>
      this.outcome(call.tenantId, { callId, ...input });
    try {
      // Taken once: a second job for the same call is refused here.
      if ((await outcome({ step: 'started' })) !== 'done') return 'held';
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof NotFoundException) return 'not requested';
      throw e;
    }
    const fail = async (error: string) => {
      await outcome({ step: 'failed', error: error.slice(0, 500) });
      return 'failed';
    };
    const provider = call.provider ? telephonyProviders.get(call.provider) : undefined;
    if (!provider || !call.toNumber) return fail('The provider is gone');
    let credentials: unknown;
    if (provider.connector) {
      const found = await providerFor(this.db, call.tenantId);
      if (found?.provider.name !== provider.name || !found.connectionId)
        return fail('The business has no connection for this provider');
      const opened = await openConnection(this.db, call.tenantId, found.connectionId);
      if (!opened) return fail('The connection’s credentials do not open');
      credentials = opened.credentials;
    }
    let out: Awaited<ReturnType<typeof provider.dial>>;
    try {
      out = await provider.dial(
        {
          callId,
          to: call.toNumber,
          ...(call.fromNumber ? { from: call.fromNumber } : {}),
          ...(call.resourceType && call.resourceId && entityDef(call.resourceType)
            ? { record: { entity: call.resourceType, id: call.resourceId } }
            : {}),
        },
        { credentials },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn(`dialling ${callId} through ${provider.name}: ${message}`);
      // Never dial twice: a refusal or a lost answer ends the call as failed.
      return fail(message);
    }
    await outcome({
      step: 'placed',
      externalId: out.externalId,
      ...(out.status ? { status: out.status } : {}),
    });
    return 'dialled';
  }

  /** One step of a dial, written through the write path; its events published after commit. */
  private async outcome(tenantId: string, input: DialOutcome): Promise<string> {
    const out = await runWrite(
      this.db,
      {
        principal: systemPrincipal({ tenantId, job: 'calls.dial' }),
        requestId: `calls.dial:${input.callId}:${input.step}`,
      },
      callDialOutcome(),
      input,
    );
    for (const event of out.events) this.events.publish(event);
    return out.result.status;
  }
}
