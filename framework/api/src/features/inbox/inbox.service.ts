import type { InboxEntry, InboxPage, InboxQuery, MarkInboxRead, Principal } from '@hykr/contracts';
import { recordEvents, systemPrincipal } from '@hykr/core';
import { type Database, inboxItems } from '@hykr/db';
import { userIdOf } from '@hykr/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { DeliveryOutcome, DeliveryRequest } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { decodeKeyset, encodeKeyset, keysetTime, olderThan } from './cursor.js';

type ItemRow = typeof inboxItems.$inferSelect;

const log = new Logger('Inbox');

/** An item as its owner reads it. */
export function entryOf(row: ItemRow): InboxEntry {
  return {
    id: row.id,
    notification: row.notification,
    title: row.title,
    body: row.body,
    url: row.url,
    record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What a stored text may hold at most (a notification's function could return anything). */
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The in-app inbox: what notifications that list `inapp` leave for a person, in one business.
 * Only that person reads it and marks it read.
 */
@Injectable()
export class InboxService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The person and business a request reads: the signed-in person, where they work. */
  private owner(p: Principal): SQL {
    return and(
      eq(inboxItems.tenantId, p.tenantId ?? ''),
      eq(inboxItems.userId, userIdOf(p) ?? ''),
    ) as SQL;
  }

  /**
   * One notification into one person's inbox. A contact without an account has none (the next
   * channel is tried). The same dedupe key twice adds nothing. The live stream hears of it.
   */
  async deliver(req: DeliveryRequest): Promise<DeliveryOutcome> {
    const content = req.notification.inapp;
    if (!content) return { status: 'failed', reason: 'no in-app content', final: true };
    const userId = req.to.userId;
    if (!userId) return { status: 'unavailable', reason: 'no account to keep an inbox for' };
    const row = req.row as never;
    const record = content.record?.(row);
    try {
      await this.db.transaction(async (tx) => {
        const [item] = await tx
          .insert(inboxItems)
          .values({
            tenantId: req.tenantId,
            userId,
            notification: req.notification.key,
            dedupe: req.dedupe,
            title: clip(content.title(row, req.reader), 200),
            body: clip(content.body(row, req.reader), 1000),
            url: content.url?.(row) ?? null,
            recordType: record?.type ?? null,
            recordId: record?.id ?? null,
          })
          .onConflictDoNothing({
            target: [inboxItems.tenantId, inboxItems.userId, inboxItems.dedupe],
          })
          .returning({ id: inboxItems.id });
        if (!item) return;
        // Ids only reach the live stream: the owner's app refreshes their inbox.
        await recordEvents(tx, {
          principal: systemPrincipal({ tenantId: req.tenantId, job: 'inbox.deliver' }),
          events: [
            {
              eventName: 'inbox.added',
              row: { id: item.id, tenantId: req.tenantId, userId },
              resourceType: 'inbox',
              resourceId: item.id,
            },
          ],
        });
      });
      return { status: 'sent' };
    } catch (e) {
      log.error(`${req.notification.key}: ${e instanceof Error ? e.message : e}`);
      return { status: 'failed', reason: 'could not store it', final: false };
    }
  }

  /** The person's items here, newest first, and how many are unread. */
  async list(p: Principal, q: z.output<typeof InboxQuery>): Promise<InboxPage> {
    const mine = this.owner(p);
    const rows = await this.db
      .select({ row: inboxItems, at: keysetTime(inboxItems.createdAt) })
      .from(inboxItems)
      .where(
        and(
          mine,
          q.unread ? isNull(inboxItems.readAt) : undefined,
          q.cursor
            ? olderThan(decodeKeyset(q.cursor), inboxItems.createdAt, inboxItems.id)
            : undefined,
        ),
      )
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      items: items.map((r) => entryOf(r.row)),
      nextCursor:
        rows.length > q.limit && last ? encodeKeyset({ at: last.at, id: last.row.id }) : null,
      unread: await this.unread(p),
    };
  }

  async unread(p: Principal): Promise<number> {
    const [c] = await this.db
      .select({ n: count() })
      .from(inboxItems)
      .where(and(this.owner(p), isNull(inboxItems.readAt)));
    return Number(c?.n ?? 0);
  }

  /** These items (the person's own; any other id is ignored), or all of them, are read. */
  async markRead(p: Principal, body: MarkInboxRead): Promise<void> {
    await this.db
      .update(inboxItems)
      .set({ readAt: new Date() })
      .where(
        and(
          this.owner(p),
          isNull(inboxItems.readAt),
          body.ids ? inArray(inboxItems.id, body.ids) : undefined,
        ),
      );
  }

  /** Is this item the person's, in this business? (The live stream's check.) */
  async visible(p: Principal, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(and(this.owner(p), eq(inboxItems.id, id)))
      .limit(1);
    return !!row;
  }
}
