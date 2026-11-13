// What the framework's own tables hold about a person in one business (B18): their account,
// membership, customer records, contacts and what was said on them, threads, saved pages,
// approvals they asked for, the outside clients they allowed, and the activity audit names them
// in. Exported as it is; erased in the erasure's transaction. Nothing here loads Nest.
import type { Conn, Tx } from '@hykr/core';
import {
  account,
  approvals,
  events as auditEvents,
  channelLinks,
  consents,
  contacts,
  customers,
  memberships,
  messages,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  pages,
  partyMembers,
  session,
  threadMessages,
  threads,
  user,
  verification,
} from '@hykr/db';
import { and, asc, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import type { ErasedRecords } from '../../hooks.js';
import { approvalCopies, both, createdBy } from '../../privacy/contributors.js';
import type { Identities } from './subject.js';

type Values = Record<string, unknown>;

/** What a customer record nobody holds any more is called. */
export const ERASED_CUSTOMER = 'Erased customer';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Their threads here: the account's and each contact's. */
function threadsOf(ids: Identities): SQL | undefined {
  const owners: SQL[] = [];
  if (ids.userId) owners.push(eq(threads.ownerId, ids.userId));
  if (ids.contactIds.length) owners.push(inArray(threads.contactId, ids.contactIds));
  return owners.length
    ? (and(eq(threads.tenantId, ids.tenantId), or(...owners)) as SQL)
    : undefined;
}

/** Audit rows of what was done by them or for them here. */
function activityOf(ids: Identities): SQL {
  const actors = [ids.userId, ...ids.contactIds].filter((x): x is string => !!x);
  return and(
    eq(auditEvents.tenantId, ids.tenantId),
    or(
      inArray(auditEvents.actorId, actors),
      inArray(auditEvents.actingFor, [...actors, ...ids.keys]),
    ),
  ) as SQL;
}

/** The framework's parts of a person's export, by name. */
export async function exportFramework(
  conn: Conn,
  ids: Identities,
): Promise<Record<string, Values[]>> {
  const out: Record<string, Values[]> = {};
  const t = ids.tenantId;
  if (ids.userId) {
    const [u] = await conn.select().from(user).where(eq(user.id, ids.userId));
    out.account = u
      ? [
          {
            id: u.id,
            name: u.name,
            email: u.email,
            emailVerified: u.emailVerified,
            createdAt: iso(u.createdAt),
          },
        ]
      : [];
    out.memberships = (
      await conn
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, t), eq(memberships.userId, ids.userId)))
    ).map((m) => ({ tenantId: m.tenantId, roles: m.roles, createdAt: iso(m.createdAt) }));
    out.pages = (
      await conn
        .select({ id: pages.id, name: pages.name, createdAt: pages.createdAt })
        .from(pages)
        .where(and(eq(pages.tenantId, t), eq(pages.ownerId, ids.userId)))
    ).map((p) => ({ ...p, createdAt: iso(p.createdAt) }));
    out.links = (
      await conn
        .select()
        .from(channelLinks)
        .where(and(eq(channelLinks.tenantId, t), eq(channelLinks.ownerId, ids.userId)))
    ).map((l) => ({ channel: l.channel, address: l.address, createdAt: iso(l.createdAt) }));
    // The outside clients (MCP) they allowed to act for them here.
    out['mcp-connections'] = (
      await conn
        .select({ consent: oauthConsent, name: oauthClient.name, uri: oauthClient.uri })
        .from(oauthConsent)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .where(and(eq(oauthConsent.userId, ids.userId), eq(oauthConsent.referenceId, t)))
        .orderBy(asc(oauthConsent.createdAt))
    ).map((r) => ({
      clientId: r.consent.clientId,
      name: r.name ?? r.consent.clientId,
      uri: r.uri,
      scopes: [...r.consent.scopes],
      connectedAt: iso(r.consent.createdAt),
      updatedAt: iso(r.consent.updatedAt),
    }));
  }
  out.customers = ids.customerIds.length
    ? (
        await conn
          .select({
            id: customers.id,
            displayName: customers.displayName,
            createdAt: customers.createdAt,
          })
          .from(customers)
          .where(and(eq(customers.tenantId, t), inArray(customers.id, ids.customerIds)))
      ).map((c) => ({ ...c, createdAt: iso(c.createdAt) }))
    : [];
  if (ids.contactIds.length) {
    out.contacts = (
      await conn.select().from(contacts).where(inArray(contacts.id, ids.contactIds))
    ).map((c) => ({
      id: c.id,
      channel: c.channel,
      address: c.address,
      profileName: c.profileName,
      locale: c.locale,
      timeZone: c.timeZone,
      linkedAt: iso(c.linkedAt),
      welcomedAt: iso(c.welcomedAt),
      createdAt: iso(c.createdAt),
    }));
    out.consents = (
      await conn
        .select()
        .from(consents)
        .where(inArray(consents.contactId, ids.contactIds))
        .orderBy(asc(consents.at))
    ).map((c) => ({ topic: c.topic, granted: c.granted, source: c.source, at: iso(c.at) }));
    out.messages = (
      await conn
        .select()
        .from(messages)
        .where(and(eq(messages.tenantId, t), inArray(messages.contactId, ids.contactIds)))
        .orderBy(asc(messages.at))
    ).map((m) => ({
      channel: m.channel,
      direction: m.direction,
      kind: m.kind,
      body: m.body,
      template: m.template,
      status: m.status,
      at: iso(m.at),
    }));
  }
  const theirThreads = threadsOf(ids);
  if (theirThreads) {
    const own = await conn.select().from(threads).where(theirThreads);
    out.threads = own.map((r) => ({ id: r.id, title: r.title, createdAt: iso(r.createdAt) }));
    out['thread-messages'] = own.length
      ? (
          await conn
            .select()
            .from(threadMessages)
            .where(
              inArray(
                threadMessages.threadId,
                own.map((r) => r.id),
              ),
            )
            .orderBy(asc(threadMessages.seq))
        ).map((m) => ({
          threadId: m.threadId,
          role: m.role,
          text: m.text,
          channel: m.channel,
          lang: m.lang,
          createdAt: iso(m.createdAt),
        }))
      : [];
  }
  const asked = [
    ids.userId ? eq(approvals.ownerId, ids.userId) : undefined,
    ids.contactIds.length ? inArray(approvals.requesterContactId, ids.contactIds) : undefined,
  ].filter((x): x is SQL => !!x);
  out.approvals = (
    await conn
      .select()
      .from(approvals)
      .where(and(eq(approvals.tenantId, t), or(...asked)))
      .orderBy(asc(approvals.createdAt))
  ).map((a) => ({
    id: a.id,
    action: a.action,
    summary: a.summary,
    status: a.status,
    createdAt: iso(a.createdAt),
    decidedAt: iso(a.decidedAt),
  }));
  out.activity = (
    await conn.select().from(auditEvents).where(activityOf(ids)).orderBy(asc(auditEvents.at))
  ).map((e) => ({
    at: iso(e.at),
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    actorKind: e.actorKind,
    channel: e.channel,
    outcome: e.outcome,
  }));
  return out;
}

const count = (rows: readonly unknown[]) => rows.length;

/**
 * The outside clients (MCP) a person allowed: their consents, access and refresh tokens, in one
 * business (`reference_id`), or in all of them. A token stops at once: checking one needs its
 * row and its consent (features/mcp/tokens.ts). The clients stay: they belong to no one.
 */
export async function forgetGrants(tx: Tx, userId: string, tenantId?: string): Promise<number> {
  const where = <
    T extends typeof oauthConsent | typeof oauthAccessToken | typeof oauthRefreshToken,
  >(
    t: T,
  ) => and(eq(t.userId, userId), tenantId ? eq(t.referenceId, tenantId) : undefined) as SQL;
  const consented = await tx
    .delete(oauthConsent)
    .where(where(oauthConsent))
    .returning({ id: oauthConsent.id });
  const access = await tx
    .delete(oauthAccessToken)
    .where(where(oauthAccessToken))
    .returning({ id: oauthAccessToken.id });
  const refresh = await tx
    .delete(oauthRefreshToken)
    .where(where(oauthRefreshToken))
    .returning({ id: oauthRefreshToken.id });
  return consented.length + access.length + refresh.length;
}

/**
 * The account's part of an erasure here: saved pages, WhatsApp links, threads (their messages go
 * with them), approvals left pending, customer records (anonymised, unlinked), the outside
 * clients they allowed here (consents and tokens) and the membership. The contacts go last, after
 * every contributor (`deleteContacts`). The pages (with those they deleted before), approvals
 * and customer records whose copies lose their words are added to `erased`.
 */
export async function eraseFramework(
  tx: Tx,
  ids: Identities,
  erased: ErasedRecords[] = [],
): Promise<Record<string, number>> {
  const t = ids.tenantId;
  const out: Record<string, number> = {};
  const theirThreads = threadsOf(ids);
  if (theirThreads)
    out.threads = count(await tx.delete(threads).where(theirThreads).returning({ id: threads.id }));
  if (!ids.userId) return out;
  const u = ids.userId;
  const pagesGone = await tx
    .delete(pages)
    .where(and(eq(pages.tenantId, t), eq(pages.ownerId, u)))
    .returning({ id: pages.id });
  out.pages = pagesGone.length;
  // With the pages they saved and deleted before: their copies stay otherwise.
  const saved = await createdBy(tx, { type: 'page', userId: u, tenantId: t });
  erased.push({
    type: 'page',
    ids: both(
      pagesGone.map((r) => r.id),
      saved,
    ),
    fields: ['name', 'spec'],
    deleted: true,
  });
  out.links = count(
    await tx
      .delete(channelLinks)
      .where(and(eq(channelLinks.tenantId, t), eq(channelLinks.ownerId, u)))
      .returning({ id: channelLinks.id }),
  );
  const asked = await tx
    .delete(approvals)
    .where(
      and(eq(approvals.tenantId, t), eq(approvals.ownerId, u), eq(approvals.status, 'pending')),
    )
    .returning({ id: approvals.id });
  out.approvals = asked.length;
  erased.push(approvalCopies(asked.map((r) => r.id)));
  const unlinked = await tx
    .update(customers)
    .set({ displayName: ERASED_CUSTOMER, userId: null })
    .where(and(eq(customers.tenantId, t), eq(customers.userId, u)))
    .returning({ id: customers.id });
  out.customers = unlinked.length;
  erased.push({ type: 'customer', ids: unlinked.map((r) => r.id), fields: ['displayName'] });
  out.oauth = await forgetGrants(tx, u, t);
  out.memberships = count(
    await tx
      .delete(memberships)
      .where(and(eq(memberships.tenantId, t), eq(memberships.userId, u)))
      .returning({ userId: memberships.userId }),
  );
  return out;
}

/** The contacts themselves: consents, messages, handoffs and their own threads go with them. */
export async function deleteContacts(
  tx: Tx,
  ids: Identities,
  erased: ErasedRecords[] = [],
): Promise<number> {
  if (!ids.contactIds.length) return 0;
  const gone = await tx
    .delete(contacts)
    .where(and(eq(contacts.tenantId, ids.tenantId), inArray(contacts.id, ids.contactIds)))
    .returning({ id: contacts.id });
  // Their copies: the number, the name, and a consent's note (`channel.consent.recorded`).
  erased.push({
    type: 'contact',
    ids: gone.map((r) => r.id),
    fields: ['address', 'displayName', 'note'],
    deleted: true,
  });
  return gone.length;
}

/** The email an erased account keeps: unique, and never delivered. */
export const erasedEmail = (userId: string) => `erased-${userId}@erased.invalid`;

/**
 * The login, once the person is in no business and no party: its name, email and picture go,
 * with its sessions, credentials, pending verifications and every outside client's grant. The
 * row stays (audit and foreign keys name it). Returns whether it was anonymised.
 */
export async function forgetAccount(tx: Tx, userId: string): Promise<boolean> {
  const [member] = await tx
    .select({ t: memberships.tenantId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  const [party] = await tx
    .select({ id: partyMembers.id })
    .from(partyMembers)
    .where(eq(partyMembers.userId, userId))
    .limit(1);
  if (member || party) return false;
  const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!u) return false;
  await tx.delete(session).where(eq(session.userId, userId));
  await tx.delete(account).where(eq(account.userId, userId));
  await tx.delete(verification).where(eq(verification.identifier, u.email));
  await forgetGrants(tx, userId);
  await tx
    .update(user)
    .set({ name: '', email: erasedEmail(userId), emailVerified: false, image: null })
    .where(eq(user.id, userId));
  // Contacts elsewhere that were linked to the account are no longer anyone's.
  await tx
    .update(contacts)
    .set({ userId: null })
    .where(and(eq(contacts.userId, userId), isNotNull(contacts.userId)));
  return true;
}
