// The integration bus and personal data (B18, decisions H4). A delivery keeps the exact body it
// sends (a record, projected for the endpoint), and an attempt keeps the start of the receiver's
// answer. An inbound event keeps what the outside system sent. These copies are redacted the way
// audit rows are: the rows and their ids stay, and the personal data goes.
// - Records erased or blanked (by an erasure or a retention rule): their fields leave the bodies
//   of their deliveries, those deliveries' attempts lose the answer, and an inbound event whose
//   handler wrote one of them is emptied (its payload has the sender's shape, so we cannot tell
//   which of its values were the record's).
// - A person forgotten: every stored body or payload value that is their email or number becomes
//   null.
import type { Subject } from '@hykr/contracts';
import type { Conn, Tx } from '@hykr/core';
import {
  contacts,
  integrationAttempts,
  integrationDeliveries,
  integrationInbound,
  user,
} from '@hykr/db';
import { and, eq, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { ErasureContributor } from '../../hooks.js';
import { definePersonalDataPart, type RecordCopies } from '../privacy/registry.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** An object without these keys, or null when it had none of them. */
function withoutFields(v: unknown, fields: readonly string[]): Obj | null {
  if (!isObj(v) || !fields.some((f) => Object.hasOwn(v, f))) return null;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !fields.includes(k)));
}

/**
 * A stored webhook body with these fields out of its record and the record before; null when
 * there was nothing to take out (or the body does not parse).
 */
export function redactBody(body: string, fields: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObj(parsed) || !isObj(parsed.data)) return null;
  const row = withoutFields(parsed.data.row, fields);
  const before = withoutFields(parsed.data.before, fields);
  if (!row && !before) return null;
  return JSON.stringify({
    ...parsed,
    data: { ...parsed.data, ...(row ? { row } : {}), ...(before ? { before } : {}) },
  });
}

/** Their attempts lose the receiver's answer, which may echo what was sent. */
async function forgetAnswers(tx: Tx, deliveryIds: readonly string[]): Promise<number> {
  if (!deliveryIds.length) return 0;
  return (
    await tx
      .update(integrationAttempts)
      .set({ response: null })
      .where(
        and(
          inArray(integrationAttempts.deliveryId, [...deliveryIds]),
          isNotNull(integrationAttempts.response),
        ),
      )
      .returning({ id: integrationAttempts.id })
  ).length;
}

/** Where B10's inbound handlers write from: runWrite's request id `inbound-<event id>`. */
const INBOUND_REQUEST = 'inbound-';

/**
 * The bus's copies of erased records, redacted with the server's (`redactCopies`): their
 * deliveries' bodies lose the fields, those deliveries' attempts the answers, and the inbound
 * events whose handlers wrote them their payload.
 */
export const integrationCopies: RecordCopies = {
  name: 'integrations',
  async redact({ tx, tenantId, set }): Promise<Record<string, number>> {
    if (!set.ids.length) return {};
    const sent = await tx
      .select({ id: integrationDeliveries.id, body: integrationDeliveries.body })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.tenantId, tenantId),
          eq(integrationDeliveries.resourceType, set.type),
          inArray(integrationDeliveries.resourceId, [...set.ids]),
        ),
      );
    let deliveries = 0;
    for (const d of sent) {
      const body = redactBody(d.body, set.fields);
      if (body === null) continue;
      await tx
        .update(integrationDeliveries)
        .set({ body, updatedAt: new Date() })
        .where(eq(integrationDeliveries.id, d.id));
      deliveries++;
    }
    const attempts = await forgetAnswers(
      tx,
      sent.map((d) => d.id),
    );
    const { rows: wrote } = await tx.execute<{ id: string }>(sql`
      select distinct substr(request_id, ${INBOUND_REQUEST.length + 1}) as id from audit.events
      where tenant_id = ${tenantId} and resource_type = ${set.type}
        and resource_id in (${sql.join(
          set.ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        and request_id like ${`${INBOUND_REQUEST}%`}`);
    const inboundIds = wrote.map((r) => r.id);
    const inbound = inboundIds.length
      ? (
          await tx
            .update(integrationInbound)
            .set({ data: null })
            .where(
              and(
                eq(integrationInbound.tenantId, tenantId),
                inArray(integrationInbound.id, inboundIds),
                isNotNull(integrationInbound.data),
              ),
            )
            .returning({ id: integrationInbound.id })
        ).length
      : 0;
    return { deliveries, attempts, inbound };
  },
};

/** The values a subject is named by in a payload: their email, or their number (± `+`). */
async function valuesOf(conn: Conn, subject: Subject, tenantId?: string): Promise<string[]> {
  if (subject.kind === 'user') {
    const [u] = await conn
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, subject.userId));
    const email = u?.email.trim().toLowerCase();
    return email ? [email] : [];
  }
  const [c] = await conn
    .select({ address: contacts.address })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, subject.contactId),
        tenantId ? eq(contacts.tenantId, tenantId) : undefined,
      ),
    );
  if (!c) return [];
  const digits = c.address.replace(/^\+/, '');
  return [digits, `+${digits}`];
}

/** A JSON value with every string that is one of these (case aside) as null; null: none was. */
export function nullValues(v: unknown, values: readonly string[]): unknown | null {
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      if (values.includes(x.trim().toLowerCase())) {
        changed = true;
        return null;
      }
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  const out = walk(v);
  return changed ? out : null;
}

/** Text holding one of these values as a JSON string, case aside (a candidate, walked after). */
const holds = (text: SQL, values: readonly string[]): SQL =>
  or(
    ...values.map((v) => sql`position(${JSON.stringify(v).toLowerCase()} in lower(${text})) > 0`),
  ) as SQL;

/**
 * "Delete my data": in the business, every stored webhook body and inbound payload value that is
 * the person's email or the contact's number becomes null (those deliveries' attempts lose the
 * answers). A value that only contains it is left: a guess would blank the wrong data.
 */
export const integrationsErasure: ErasureContributor = {
  name: 'integrations',
  async erase({ subject, tenantId, tx }) {
    const values = await valuesOf(tx, subject, tenantId);
    if (!values.length) return { count: 0 };
    const received = await tx
      .select({ id: integrationInbound.id, data: integrationInbound.data })
      .from(integrationInbound)
      .where(
        and(
          tenantId ? eq(integrationInbound.tenantId, tenantId) : undefined,
          isNotNull(integrationInbound.data),
          holds(sql`${integrationInbound.data}::text`, values),
        ) as SQL,
      );
    let n = 0;
    for (const r of received) {
      const data = nullValues(r.data, values);
      if (data === null) continue;
      await tx.update(integrationInbound).set({ data }).where(eq(integrationInbound.id, r.id));
      n++;
    }
    const sent = await tx
      .select({ id: integrationDeliveries.id, body: integrationDeliveries.body })
      .from(integrationDeliveries)
      .where(
        and(
          tenantId ? eq(integrationDeliveries.tenantId, tenantId) : undefined,
          holds(sql`${integrationDeliveries.body}`, values),
        ) as SQL,
      );
    const changed: string[] = [];
    for (const d of sent) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(d.body);
      } catch {
        continue;
      }
      const body = nullValues(parsed, values);
      if (body === null) continue;
      await tx
        .update(integrationDeliveries)
        .set({ body: JSON.stringify(body), updatedAt: new Date() })
        .where(eq(integrationDeliveries.id, d.id));
      changed.push(d.id);
    }
    n += changed.length + (await forgetAnswers(tx, changed));
    return { count: n };
  },
};

/** What the register lists of the bus. */
export const integrationsParts = [
  definePersonalDataPart({
    name: 'integrations.payloads',
    label: {
      en: 'Webhooks sent and received, as stored',
      hi: 'भेजे और मिले वेबहुक, जैसे रखे गए',
      te: 'పంపిన, అందిన వెబ్‌హుక్‌లు, నిల్వ చేసినట్లు',
    },
    fields: ['body', 'response', 'data'],
    erase: 'anonymise',
  }),
];
