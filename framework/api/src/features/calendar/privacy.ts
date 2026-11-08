// Calendars and personal data (B18, decisions H4): a person's calendar connections (the Google
// account and its tokens), the records in their calendar, their private feeds and sign-ins under
// way, and the invites emailed to them. A copy lists them; being forgotten deletes them, and once
// that has committed our events leave their calendar and the grant is revoked, as a disconnect
// does.
import type { Subject } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import {
  calendarConnections,
  calendarEventLinks,
  calendarFeeds,
  calendarInvites,
  calendarOauthStates,
  integrationConnections,
  user,
} from '@hykr/db';
import { and, type Column, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { ErasedRecords, ErasureContributor, ExportContributor } from '../../hooks.js';
import { definePersonalDataPart } from '../privacy/registry.js';
import { CalendarSyncService, type Leftovers } from './sync.service.js';
import { openTokens } from './tokens.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** In one business, or in all of them. */
const inBusiness = (col: Column, tenantId?: string) => (tenantId ? eq(col, tenantId) : undefined);

/** The person's account email, lower case: invites are addressed by it. */
async function emailOf(conn: Conn, userId: string): Promise<string | null> {
  const [u] = await conn.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return u?.email.trim().toLowerCase() || null;
}

/** The invites addressed to the person: to their account, or to its email. */
const invitesTo = (userId: string, email: string | null, tenantId?: string): SQL =>
  and(
    inBusiness(calendarInvites.tenantId, tenantId),
    or(
      eq(calendarInvites.userId, userId),
      email ? sql`lower(${calendarInvites.email}) = ${email}` : undefined,
    ),
  ) as SQL;

const userOf = (s: Subject) => (s.kind === 'user' ? s.userId : null);

/**
 * "Delete my data" for a person: their connections (their tokens, the records' event links and
 * the inbound connection behind the push channel go with them), their feeds, their sign-ins under
 * way and the invites addressed to them. Google is cleaned up after the commit, best effort.
 * Invites the person asked for are other people's: they stay.
 */
export const calendarErasure: ErasureContributor = {
  name: 'calendar',
  async erase({ subject, tenantId, tx }) {
    const userId = userOf(subject);
    if (!userId) return { count: 0 };
    const connections = await tx
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.userId, userId),
          inBusiness(calendarConnections.tenantId, tenantId),
        ),
      );
    const left: Leftovers[] = [];
    for (const row of connections)
      left.push({
        row,
        tokens: openTokens(row),
        links: await tx
          .select()
          .from(calendarEventLinks)
          .where(eq(calendarEventLinks.connectionId, row.id)),
      });
    if (connections.length) {
      await tx.delete(calendarConnections).where(
        inArray(
          calendarConnections.id,
          connections.map((c) => c.id),
        ),
      );
      for (const c of connections)
        if (c.inboundConnectionId)
          await tx
            .delete(integrationConnections)
            .where(
              and(
                eq(integrationConnections.id, c.inboundConnectionId),
                eq(integrationConnections.tenantId, c.tenantId),
              ),
            );
    }
    const feeds = await tx
      .delete(calendarFeeds)
      .where(and(eq(calendarFeeds.userId, userId), inBusiness(calendarFeeds.tenantId, tenantId)))
      .returning({ id: calendarFeeds.id });
    const states = await tx
      .delete(calendarOauthStates)
      .where(
        and(
          eq(calendarOauthStates.userId, userId),
          inBusiness(calendarOauthStates.tenantId, tenantId),
        ),
      )
      .returning({ id: calendarOauthStates.id });
    const invites = await tx
      .delete(calendarInvites)
      .where(invitesTo(userId, await emailOf(tx, userId), tenantId))
      .returning({ id: calendarInvites.id });
    const erased: ErasedRecords[] = [
      {
        type: 'calendarConnection',
        ids: connections.map((c) => c.id),
        fields: ['account', 'lastError'],
        deleted: true,
      },
      { type: 'calendarFeed', ids: feeds.map((f) => f.id), fields: ['label'], deleted: true },
      {
        type: 'calendarInvite',
        ids: invites.map((i) => i.id),
        fields: ['email', 'to', 'name'],
        deleted: true,
      },
    ];
    const cleanUp = left.filter((l) => l.tokens);
    return {
      count: connections.length + feeds.length + states.length + invites.length,
      erased,
      ...(cleanUp.length
        ? {
            afterCommit: async (ctx) => {
              const sync = ctx.get(CalendarSyncService);
              for (const l of cleanUp) await sync.cleanUp(l);
            },
          }
        : {}),
    };
  },
};

/** A person's calendars, the records in them, their feeds and the invites sent to them. */
export const calendarExport: ExportContributor = {
  name: 'calendar',
  async export({ subject, tenantId, db }): Promise<Record<string, readonly unknown[]>> {
    const userId = userOf(subject);
    if (!userId) return {};
    const connections = await db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.userId, userId),
          inBusiness(calendarConnections.tenantId, tenantId),
        ),
      );
    const links = connections.length
      ? await db
          .select()
          .from(calendarEventLinks)
          .where(
            inArray(
              calendarEventLinks.connectionId,
              connections.map((c) => c.id),
            ),
          )
      : [];
    const feeds = await db
      .select()
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.userId, userId), inBusiness(calendarFeeds.tenantId, tenantId)));
    const invites = await db
      .select()
      .from(calendarInvites)
      .where(invitesTo(userId, await emailOf(db, userId), tenantId));
    return {
      // Never the sealed tokens or the channel's ids: what the connection is, not its keys.
      calendarConnections: connections.map((c) => ({
        id: c.id,
        tenantId: c.tenantId,
        provider: c.provider,
        account: c.account,
        calendarId: c.calendarId,
        status: c.status,
        scopes: c.scopes,
        lastSyncedAt: iso(c.lastSyncedAt),
        createdAt: iso(c.createdAt),
      })),
      calendarEvents: links.map((l) => ({
        connectionId: l.connectionId,
        record: { entity: l.resourceType, id: l.resourceId },
        externalId: l.externalId,
        status: l.status,
        startsAt: iso(l.sentStartsAt),
        endsAt: iso(l.sentEndsAt),
        movedTo:
          l.externalStartsAt || l.externalEndsAt
            ? { startsAt: iso(l.externalStartsAt), endsAt: iso(l.externalEndsAt) }
            : null,
        syncedAt: iso(l.syncedAt),
      })),
      calendarFeeds: feeds.map((f) => ({
        id: f.id,
        tenantId: f.tenantId,
        label: f.label,
        lastUsedAt: iso(f.lastUsedAt),
        createdAt: iso(f.createdAt),
      })),
      calendarInvites: invites.map((i) => ({
        id: i.id,
        tenantId: i.tenantId,
        record: { entity: i.resourceType, id: i.resourceId },
        email: i.email,
        name: i.name,
        method: i.method,
        sequence: i.sequence,
        status: i.status,
        sent: i.sent,
        sentAt: iso(i.sentAt),
        createdAt: iso(i.createdAt),
      })),
    };
  },
};

/** What the register lists of calendars. */
export const calendarParts = [
  definePersonalDataPart({
    name: 'calendar.connections',
    label: {
      en: 'Connected calendars and the records in them',
      hi: 'जुड़े हुए कैलेंडर और उनमें रखे रिकॉर्ड',
      te: 'కనెక్ట్ చేసిన క్యాలెండర్లు, వాటిలోని రికార్డులు',
    },
    fields: ['account', 'tokens', 'feeds'],
    erase: 'delete',
  }),
  definePersonalDataPart({
    name: 'calendar.invites',
    label: {
      en: 'Calendar invites sent by email',
      hi: 'ईमेल से भेजे गए कैलेंडर आमंत्रण',
      te: 'ఈమెయిల్‌లో పంపిన క్యాలెండర్ ఆహ్వానాలు',
    },
    fields: ['email', 'name'],
    erase: 'delete',
  }),
];
