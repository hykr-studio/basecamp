// Push notifications (A9): a person's phones, the `push` delivery channel, and the receipt poll
// that moves a notification to its next channel when every device's message failed.
// docs/decisions/A9B15.md.
import { pushTickets, pushTokens } from '@hykr/db';
import { and, eq, type SQL } from 'drizzle-orm';
import { config } from '../../config.js';
import type { DataSubject, ErasureContributor, ExportContributor } from '../../hooks.js';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineFeature } from '../feature.js';
import { PushChannel } from './push.channel.js';
import { PushController } from './push.controller.js';
import { maskToken, PushService } from './push.service.js';

/** Checks the receipts of sends old enough to have one (PushService.pollReceipts). */
export const PushReceiptsQueue = defineQueue<unknown, { checked: number; fellBack: number }>({
  name: 'push.receipts',
  process: async (_job, ctx) => ctx.get(PushService).pollReceipts(config.queuePrefix),
});

/** Every minute. */
export const PushReceiptsSchedule = defineSchedule({
  name: 'push.receipts',
  queue: PushReceiptsQueue.name,
  every: 60_000,
});

/** A person's devices and push log, in one business or all. Contacts have none. */
const whose = (a: DataSubject, table: typeof pushTokens | typeof pushTickets): SQL | undefined =>
  a.subject.kind === 'user'
    ? and(
        eq(table.userId, a.subject.userId),
        a.tenantId ? eq(table.tenantId, a.tenantId) : undefined,
      )
    : undefined;

/** Forgetting a person: their devices and what was pushed to them. */
export const PushErasure: ErasureContributor = {
  name: 'push',
  erase: async (a) => {
    const tokens = whose(a, pushTokens);
    const tickets = whose(a, pushTickets);
    if (!tokens || !tickets) return { count: 0 };
    const gone = await a.tx.delete(pushTokens).where(tokens).returning({ id: pushTokens.id });
    const sent = await a.tx.delete(pushTickets).where(tickets).returning({ id: pushTickets.id });
    return { count: gone.length + sent.length };
  },
};

/** A person's export: their devices, the token shortened. */
export const PushExport: ExportContributor = {
  name: 'push',
  export: async (a): Promise<Record<string, readonly unknown[]>> => {
    const where = whose(a, pushTokens);
    if (!where) return {};
    const rows = await a.db.select().from(pushTokens).where(where);
    return {
      pushDevices: rows.map((r) => ({
        platform: r.platform,
        token: maskToken(r.token),
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
      })),
    };
  },
};

export const pushFeature = defineFeature({
  name: 'push',
  controllers: [PushController],
  providers: [PushService, PushChannel],
  exports: [PushService],
  contributes: {
    queues: [PushReceiptsQueue],
    schedules: [PushReceiptsSchedule],
    erasureContributors: [PushErasure],
    exportContributors: [PushExport],
  },
});
