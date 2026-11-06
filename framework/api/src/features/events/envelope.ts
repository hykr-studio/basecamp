import { randomUUID } from 'node:crypto';
import type { DomainEventEnvelope } from '@hykr/contracts';
import type { NamedEvent } from '@hykr/core';

/** Dates as ISO strings: what a job and a subscriber see. */
const plain = (row: unknown) => JSON.parse(JSON.stringify(row ?? null)) as unknown;

/**
 * An in-process event (published on the event bus after commit) as an envelope. The bus does not
 * say who acted, so the actor is unknown; the event outbox carries it. An event whose row has no
 * business is not relayed (undefined): nothing may reach a subscriber without its tenant.
 */
export function envelopeOf(event: NamedEvent): DomainEventEnvelope | undefined {
  const row = plain(event.row) as Record<string, unknown> | null;
  const tenantId = row && typeof row.tenantId === 'string' ? row.tenantId : undefined;
  if (!tenantId) return undefined;
  const entity = (event as { entity?: unknown }).entity;
  return {
    id: randomUUID(),
    name: event.eventName,
    tenantId,
    resourceType: typeof entity === 'string' ? entity : event.eventName.split('.')[0],
    resourceId: typeof row?.id === 'string' ? row.id : null,
    row,
    actor: { kind: 'unknown', id: 'unknown' },
    occurredAt: new Date().toISOString(),
  };
}
