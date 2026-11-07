// The in-app inbox (B16): the `inapp` delivery channel any notification may list, a person's
// items at /api/inbox, live announcements to their owner, and erasure and export.
// docs/decisions/B16.md.
import { inboxItems } from '@hykr/db';
import { and, eq, type SQL } from 'drizzle-orm';
import type { DataSubject, ErasureContributor, ExportContributor } from '../../hooks.js';
import { defineFeature } from '../feature.js';
import '../live/resources.js';
import type { LiveResource } from '../live/resources.js';
import { InboxChannel } from './inbox.channel.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

/** A person's items, in one business or all. Contacts have none. */
const whose = (a: DataSubject): SQL | undefined =>
  a.subject.kind === 'user'
    ? and(
        eq(inboxItems.userId, a.subject.userId),
        a.tenantId ? eq(inboxItems.tenantId, a.tenantId) : undefined,
      )
    : undefined;

/** Forgetting a person: their inbox. */
export const InboxErasure: ErasureContributor = {
  name: 'inbox',
  erase: async (a) => {
    const where = whose(a);
    if (!where) return { count: 0 };
    const gone = await a.tx.delete(inboxItems).where(where).returning({ id: inboxItems.id });
    return { count: gone.length };
  },
};

/** A person's export: what their inbox holds. */
export const InboxExport: ExportContributor = {
  name: 'inbox',
  export: async (a): Promise<Record<string, readonly unknown[]>> => {
    const where = whose(a);
    if (!where) return {};
    const rows = await a.db.select().from(inboxItems).where(where);
    return {
      inbox: rows.map((r) => ({
        notification: r.notification,
        title: r.title,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })),
    };
  },
};

/** An inbox item reaches only its owner's streams. */
export const InboxLive: LiveResource = {
  type: 'inbox',
  visible: (p, id, ctx) => ctx.get(InboxService).visible(p, id),
};

export const inboxFeature = defineFeature({
  name: 'inbox',
  controllers: [InboxController],
  providers: [InboxService, InboxChannel],
  exports: [InboxService],
  contributes: {
    liveResources: [InboxLive],
    erasureContributors: [InboxErasure],
    exportContributors: [InboxExport],
  },
});
