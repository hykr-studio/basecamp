import type { DomainEventEnvelope } from '@hykr/contracts';

/**
 * What crosses Redis for one committed event: its ids, never its row. Each API process checks
 * it against each of its connections before anything leaves the server.
 */
export interface LiveSignal {
  /** The stored event's id. */
  event: string;
  name: string;
  tenantId: string;
  type: string;
  id: string;
  /** Who made the change, and for whom ('user:<id>'). */
  actor: { kind: string; id: string };
  subject: string | null;
}

/** One Redis channel per business, under the process's queue prefix (tests, worktrees). */
export const liveChannel = (prefix: string, tenantId: string) => `${prefix}:live:${tenantId}`;

export function signalOf(e: DomainEventEnvelope): LiveSignal | null {
  if (!e.resourceId) return null;
  return {
    event: e.id,
    name: e.name,
    tenantId: e.tenantId,
    type: e.resourceType,
    id: e.resourceId,
    actor: e.actor,
    subject: e.subject ?? null,
  };
}

export function parseSignal(raw: string): LiveSignal | null {
  try {
    const s = JSON.parse(raw) as Partial<LiveSignal>;
    if (
      typeof s.event !== 'string' ||
      typeof s.name !== 'string' ||
      typeof s.tenantId !== 'string' ||
      typeof s.type !== 'string' ||
      typeof s.id !== 'string' ||
      typeof s.actor?.id !== 'string'
    )
      return null;
    return s as LiveSignal;
  } catch {
    return null;
  }
}
