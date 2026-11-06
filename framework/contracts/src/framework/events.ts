import { z } from 'zod';
import { Channel } from '../voice.js';

/**
 * Something that happened to a record, as it is stored durably and passed on: to subscribers
 * and queues, webhooks and live updates. It is written in the same transaction as the change.
 * Subscribers dedupe on `id`. Fields the receiver may not see are filtered out before it leaves
 * the server, and live updates carry ids only.
 */
export const DomainEventEnvelope = z.object({
  /** Unique per event. */
  id: z.string(),
  /** What happened: 'task.created', 'visit.rescheduled', 'approval.decided'. */
  name: z.string(),
  tenantId: z.string(),
  /** The module that owns the record, once modules exist. */
  module: z.string().optional(),
  /** The record's type, as audited ('task'), and its id. */
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  /** The record after the change; `before` is the record before an update or delete. */
  row: z.unknown(),
  before: z.unknown().optional(),
  /** Who did it: a person, an agent, the system. */
  actor: z.object({ kind: z.string(), id: z.string() }),
  /** Whom it was done for: 'user:<id>' or 'contact:<id>'. */
  subject: z.string().nullable().optional(),
  channel: Channel.optional(),
  requestId: z.string().optional(),
  runId: z.string().optional(),
  occurredAt: z.iso.datetime(),
  /** Not passed on before this time (a tier 1 write's undo window). Omitted: at once. */
  availableAt: z.iso.datetime().optional(),
});
export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelope>;
