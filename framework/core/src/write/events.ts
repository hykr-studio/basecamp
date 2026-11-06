import { randomUUID } from 'node:crypto';
import { DomainEventEnvelope, type Principal } from '@hykr/contracts';
import { domainEvents } from '@hykr/db';
import { subjectKeyOf } from '@hykr/policy';
import { isNamedEvent } from '../entity/cqrs-classes.js';
import { toJson } from '../entity/define-entity.js';
import { entityDef } from '../entity/registry.js';
import { projectRead } from '../hooks.js';
import type { Tx } from '../tokens.js';

type Values = Record<string, unknown>;
type StoredEvent = typeof domainEvents.$inferSelect;

let queues = 'bull';

/**
 * The queue prefix this process stamps on the events it stores (`CoreOptions.queuePrefix`,
 * from BULL_PREFIX). A relay passes on its own prefix's events only, so a test run and a dev
 * worker on one database never take each other's.
 */
export function setEventQueues(prefix: string) {
  queues = prefix;
}
export const eventQueues = () => queues;

const asObject = (v: unknown): Values | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Values) : undefined;

/**
 * Store the named events a write produced, in its transaction: they exist exactly when the
 * write committed. Each `NamedEvent` becomes one row (other event objects stay in-process).
 * `delayMs` holds them back (a tier 1 write's undo window). The rows keep the record as
 * stored, every field included; `eventFor` filters one for its reader.
 */
export async function recordEvents(
  tx: Tx,
  a: { principal: Principal; requestId?: string; events: readonly object[]; delayMs?: number },
): Promise<DomainEventEnvelope[]> {
  const p = a.principal;
  const named = a.events.filter(isNamedEvent);
  if (!named.length) return [];
  const now = new Date();
  const availableAt = a.delayMs ? new Date(now.getTime() + a.delayMs) : now;
  const rows = named.map((event) => {
    const row = toJson(event.row) ?? null;
    const before = event.before === undefined ? null : (toJson(event.before) ?? null);
    const tenantId = p.tenantId ?? (asObject(row)?.tenantId as string | undefined);
    // An event that names no business could reach anyone: the write fails instead.
    if (!tenantId) throw new Error(`The event "${event.eventName}" belongs to no business`);
    const rowId = asObject(row)?.id;
    return {
      id: randomUUID(),
      tenantId,
      name: event.eventName,
      resourceType: event.resourceType ?? event.eventName.split('.')[0],
      resourceId: event.resourceId ?? (typeof rowId === 'string' ? rowId : null),
      row,
      before,
      actorKind: p.actor.kind,
      actorId: p.actor.id,
      subject: subjectKeyOf(p) ?? null,
      channel: p.channel ?? null,
      requestId: a.requestId ?? null,
      runId: p.runId ?? null,
      occurredAt: now,
      availableAt,
      queues,
    };
  });
  const stored = await tx.insert(domainEvents).values(rows).returning();
  return stored.map(toEnvelope);
}

/** A stored event as the envelope subscribers receive. */
export function toEnvelope(row: StoredEvent): DomainEventEnvelope {
  const delayed = row.availableAt.getTime() !== row.occurredAt.getTime();
  return DomainEventEnvelope.parse({
    id: row.id,
    name: row.name,
    tenantId: row.tenantId,
    ...(row.module ? { module: row.module } : {}),
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    row: row.row,
    ...(row.before !== null ? { before: row.before } : {}),
    actor: { kind: row.actorKind, id: row.actorId },
    subject: row.subject,
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    occurredAt: row.occurredAt.toISOString(),
    ...(delayed ? { availableAt: row.availableAt.toISOString() } : {}),
  });
}

/**
 * An event as one reader may receive it, or null. Another business's event is null. An
 * entity's record (and the one before it) is read with its read schema and projected for the
 * reader, so internal columns and hidden fields stay behind; a record the schema refuses is
 * null rather than passed on raw. Any other record goes through the read projectors. Whether
 * the reader may see that record at all is the deliverer's check (`def.repo.find`).
 */
export function eventFor(event: DomainEventEnvelope, p: Principal): DomainEventEnvelope | null {
  if (!p.tenantId || event.tenantId !== p.tenantId) return null;
  const def = entityDef(event.resourceType);
  const view = (value: unknown): unknown => {
    const record = asObject(value);
    if (!record) return value ?? null;
    if (!def) return projectRead(event.resourceType, record, p);
    const read = def.spec.schemas.read.safeParse(def.readJson(record));
    return read.success ? def.project(read.data as Values, p) : null;
  };
  return {
    ...event,
    row: view(event.row),
    ...(event.before !== undefined ? { before: view(event.before) } : {}),
  };
}
