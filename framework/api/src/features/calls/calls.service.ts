import { type CallInfo, CallsCapabilities, type Principal } from '@hykr/contracts';
import { entityDef } from '@hykr/core';
import { callLogs, type Database } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Jobs } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { openConnection } from '../integrations/credentials.js';
import {
  aboutOf,
  type CallRow,
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

  queueDial(callId: string, eventId: string) {
    return this.jobs.add<DialJob>(
      DIAL_QUEUE,
      { callId },
      { name: 'dial', jobId: `calls-dial--${eventId}` },
    );
  }

  /**
   * In the worker: ask the call's provider to connect it, once. What it answers (or why it
   * refused) is written on the call.
   */
  async dial(callId: string): Promise<string> {
    const [claimed] = await this.db
      .update(callLogs)
      .set({ status: 'ringing', updatedAt: new Date() })
      .where(and(eq(callLogs.id, callId), eq(callLogs.status, 'requested')))
      .returning();
    if (!claimed) return 'not requested';
    const fail = async (error: string) => {
      await this.db
        .update(callLogs)
        .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
        .where(eq(callLogs.id, callId));
      return 'failed';
    };
    const provider = claimed.provider ? telephonyProviders.get(claimed.provider) : undefined;
    if (!provider || !claimed.toNumber) return fail('The provider is gone');
    let credentials: unknown;
    if (provider.connector) {
      const found = await providerFor(this.db, claimed.tenantId);
      if (found?.provider.name !== provider.name || !found.connectionId)
        return fail('The business has no connection for this provider');
      const opened = await openConnection(this.db, claimed.tenantId, found.connectionId);
      if (!opened) return fail('The connection’s credentials do not open');
      credentials = opened.credentials;
    }
    try {
      const out = await provider.dial(
        {
          callId,
          to: claimed.toNumber,
          ...(claimed.fromNumber ? { from: claimed.fromNumber } : {}),
          ...(claimed.resourceType && claimed.resourceId && entityDef(claimed.resourceType)
            ? { record: { entity: claimed.resourceType, id: claimed.resourceId } }
            : {}),
        },
        { credentials },
      );
      await this.db
        .update(callLogs)
        .set({
          externalId: out.externalId,
          status: out.status ?? 'ringing',
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(callLogs.id, callId));
      return 'dialled';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn(`dialling ${callId} through ${provider.name}: ${message}`);
      // Never dial twice: a refusal or a lost answer ends the call as failed.
      return fail(message);
    }
  }
}
