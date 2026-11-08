// The call log and personal data (B18, decisions H4). A WhatsApp contact is on a call by their
// number; a person is on it as the member who made or took it. A copy lists those calls. Being
// forgotten takes the contact's number, the call's notes and its error off each call with them.
// For a member, it unlinks them and takes their own number off. The calls stay: they are the
// business's records.
import type { Subject } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import { callLogs, contacts } from '@hykr/db';
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { ErasedRecords, ErasureContributor, ExportContributor } from '../../hooks.js';
import { definePersonalDataPart } from '../privacy/registry.js';
import { callInfoOf } from './commands.js';

/** A contact's number as calls store it (E.164) and as WhatsApp does (digits). */
async function numbersOf(conn: Conn, contactId: string, tenantId?: string): Promise<string[]> {
  const [c] = await conn
    .select({ address: contacts.address })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), tenantId ? eq(contacts.tenantId, tenantId) : undefined));
  if (!c) return [];
  const digits = c.address.replace(/^\+/, '');
  return [`+${digits}`, digits];
}

const inBusiness = (tenantId?: string) => (tenantId ? eq(callLogs.tenantId, tenantId) : undefined);

/** The calls a subject is on: a contact's by number, a person's as the member. */
async function callsOf(conn: Conn, subject: Subject, tenantId?: string): Promise<SQL | null> {
  if (subject.kind === 'user')
    return and(
      inBusiness(tenantId),
      or(eq(callLogs.userId, subject.userId), eq(callLogs.loggedBy, subject.userId)),
    ) as SQL;
  const numbers = await numbersOf(conn, subject.contactId, tenantId);
  if (!numbers.length) return null;
  return and(
    inBusiness(tenantId),
    or(inArray(callLogs.fromNumber, numbers), inArray(callLogs.toNumber, numbers)),
  ) as SQL;
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

/**
 * "Delete my data". A contact's number leaves every call it is on, and those calls lose their
 * notes and error (what was said, a provider's message naming the number). A member is unlinked
 * from their calls and loses their own number: the one they called from, or the one they were
 * called on. Their notes on the business's calls with someone else stay.
 */
export const callsErasure: ErasureContributor = {
  name: 'calls',
  async erase({ subject, tenantId, tx }) {
    if (subject.kind === 'contact') {
      const numbers = await numbersOf(tx, subject.contactId, tenantId);
      if (!numbers.length) return { count: 0 };
      const list = sql.join(
        numbers.map((n) => sql`${n}`),
        sql`, `,
      );
      const fromThem = await tx
        .select({ id: callLogs.id })
        .from(callLogs)
        .where(and(inBusiness(tenantId), inArray(callLogs.fromNumber, numbers)) as SQL);
      const toThem = await tx
        .select({ id: callLogs.id })
        .from(callLogs)
        .where(and(inBusiness(tenantId), inArray(callLogs.toNumber, numbers)) as SQL);
      const changed = await tx
        .update(callLogs)
        .set({
          fromNumber: sql`case when ${callLogs.fromNumber} in (${list}) then null else ${callLogs.fromNumber} end`,
          toNumber: sql`case when ${callLogs.toNumber} in (${list}) then null else ${callLogs.toNumber} end`,
          notes: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            inBusiness(tenantId),
            or(inArray(callLogs.fromNumber, numbers), inArray(callLogs.toNumber, numbers)),
          ) as SQL,
        )
        .returning({ id: callLogs.id });
      const erased: ErasedRecords[] = [
        { type: 'call', ids: ids(fromThem), fields: ['from', 'notes', 'error'] },
        { type: 'call', ids: ids(toThem), fields: ['to', 'notes', 'error'] },
      ];
      return { count: changed.length, erased };
    }
    const userId = subject.userId;
    const mine = and(inBusiness(tenantId), eq(callLogs.userId, userId)) as SQL;
    // Their own number: the one an outbound call came from, the one an inbound call rang.
    const outbound = await tx
      .update(callLogs)
      .set({ fromNumber: null, userId: null, updatedAt: new Date() })
      .where(and(mine, eq(callLogs.direction, 'outbound')) as SQL)
      .returning({ id: callLogs.id });
    const inbound = await tx
      .update(callLogs)
      .set({ toNumber: null, userId: null, updatedAt: new Date() })
      .where(and(mine, eq(callLogs.direction, 'inbound')) as SQL)
      .returning({ id: callLogs.id });
    const logged = await tx
      .update(callLogs)
      .set({ loggedBy: null, updatedAt: new Date() })
      .where(and(inBusiness(tenantId), eq(callLogs.loggedBy, userId)) as SQL)
      .returning({ id: callLogs.id });
    const erased: ErasedRecords[] = [
      { type: 'call', ids: ids(outbound), fields: ['from', 'userId'] },
      { type: 'call', ids: ids(inbound), fields: ['to', 'userId'] },
    ];
    return {
      count: new Set([...ids(outbound), ...ids(inbound), ...ids(logged)]).size,
      erased,
    };
  },
};

/** The calls a subject was on, for their data export. */
export const callsExport: ExportContributor = {
  name: 'calls',
  async export({ subject, tenantId, db }) {
    const where = await callsOf(db, subject, tenantId);
    if (!where) return { calls: [] };
    const rows = await db.select().from(callLogs).where(where);
    return {
      calls: rows.map((r) => {
        const { userId: _userId, ...info } = callInfoOf(r);
        return { ...info, tenantId: r.tenantId };
      }),
    };
  },
};

/** What the register lists of the call log. */
export const callsParts = [
  definePersonalDataPart({
    name: 'calls.log',
    label: { en: 'Phone calls logged', hi: 'दर्ज की गई फ़ोन कॉल', te: 'నమోదు చేసిన ఫోన్ కాల్స్' },
    fields: ['fromNumber', 'toNumber', 'notes'],
    erase: 'anonymise',
  }),
];
