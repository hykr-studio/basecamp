// What an outbound webhook carries: the event's record as the endpoint may read it. Only events
// about an entity are sent, because an entity's record has a read schema and a field policy to
// project it with; anything else stays inside.
import { type DomainEventEnvelope, type Principal, sendsWebhooks } from '@hykr/contracts';
import { entityDef, eventFor, projectRead } from '@hykr/core';

type Values = Record<string, unknown>;

/** The body, as receivers parse it (Standard Webhooks' `{ type, timestamp, data }`). */
export interface WebhookBody {
  type: string;
  timestamp: string;
  data: {
    eventId: string;
    tenantId: string;
    resourceType: string;
    resourceId: string | null;
    row: unknown;
    before?: unknown;
  };
}

/** May events about this resource type leave the platform at all? */
export function webhookable(resourceType: string): boolean {
  const def = entityDef(resourceType);
  return def !== undefined && sendsWebhooks(def.spec);
}

/**
 * The exact body one endpoint gets, or null when the record cannot leave (another business, a
 * record its read schema refuses, an entity that opted out). `reader` is the endpoint's
 * principal: its capabilities decide which fields stay.
 */
export function buildBody(event: DomainEventEnvelope, reader: Principal): string | null {
  if (!webhookable(event.resourceType)) return null;
  const seen = eventFor(event, reader);
  if (!seen || seen.row === null || seen.row === undefined) return null;
  const body: WebhookBody = {
    type: event.name,
    timestamp: event.occurredAt,
    data: {
      eventId: event.id,
      tenantId: event.tenantId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      row: seen.row,
      ...(seen.before !== undefined && seen.before !== null ? { before: seen.before } : {}),
    },
  };
  return JSON.stringify(body);
}

const isRecord = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A stored body as this reader may see it (the delivery log): its records projected again, so
 * a field the endpoint was given and the reader may not see stays hidden.
 */
export function projectPayload(body: string, resourceType: string, p: Principal): unknown {
  let parsed: WebhookBody;
  try {
    parsed = JSON.parse(body) as WebhookBody;
  } catch {
    return null;
  }
  const def = entityDef(resourceType);
  const view = (v: unknown) =>
    isRecord(v) ? (def ? def.project(v, p) : projectRead(resourceType, v, p)) : v;
  const data = isRecord(parsed?.data) ? parsed.data : undefined;
  if (!data) return null;
  return {
    ...parsed,
    data: {
      ...data,
      row: view(data.row),
      ...(data.before !== undefined ? { before: view(data.before) } : {}),
    },
  };
}
