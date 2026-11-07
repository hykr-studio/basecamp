// Privacy requests as rows, as clients read them, as events, and who reaches them. Nothing here
// loads Nest.
import {
  PRIVACY_REQUEST,
  type Principal,
  PrivacyManageCapability,
  type PrivacyRequest,
  type PrivacyRequestKind,
  type TenantConfig,
} from '@hykr/contracts';
import type { NamedEvent } from '@hykr/core';
import type { privacyRequests } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import { privacyPolicy } from './registry.js';
import { sameSubject, subjectOfRow } from './subject.js';

export type RequestRow = typeof privacyRequests.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A request as its person and the business's privacy team read it. */
export function requestOut(r: RequestRow): PrivacyRequest {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    subject: { kind: r.subjectKind, id: r.subjectId },
    intake: r.intake as PrivacyRequest['intake'],
    requestedBy: { kind: r.requestedByKind, id: r.requestedById },
    note: r.note,
    reason: r.reason,
    outcome: (r.outcome ?? null) as PrivacyRequest['outcome'],
    files: r.files,
    receivedAt: r.receivedAt.toISOString(),
    dueAt: iso(r.dueAt),
    overdueAt: iso(r.overdueAt),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** What an event carries: the request without the team's note, with its business. */
export function eventRow(r: RequestRow): Record<string, unknown> {
  const { note: _note, ...rest } = requestOut(r);
  return { ...rest, tenantId: r.tenantId };
}

/**
 * privacy.request.received (waits for review), .started, .completed, .refused, .failed,
 * .overdue: the request as its row. The privacy team are the ones to tell: an application's
 * notification names `{ capability: 'privacy.manage' }`.
 */
export class PrivacyEvent implements NamedEvent {
  readonly resourceType = PRIVACY_REQUEST;
  constructor(
    readonly eventName: string,
    readonly row: Record<string, unknown>,
  ) {}
  get resourceId(): string {
    return String(this.row.id);
  }
}

/** How this business answers requests: its settings over the application's policy. */
export function effectivePolicy(settings: TenantConfig): {
  respondWithinDays: number | null;
  review: PrivacyRequestKind[];
} {
  const app = privacyPolicy();
  return {
    respondWithinDays: settings.privacy.respondWithinDays ?? app?.respondWithinDays ?? null,
    review: [...new Set([...(app?.review ?? []), ...settings.privacy.review])].sort(),
  };
}

/** When a request received at `at` must be answered. */
export const dueFrom = (at: Date, days: number | null): Date | null =>
  days ? new Date(at.getTime() + days * 86_400_000) : null;

/** May p read this request: its own person, or the business's privacy team? */
export function reachesRequest(p: Principal, r: RequestRow): boolean {
  if (!p.tenantId || p.tenantId !== r.tenantId) return false;
  if (p.actor.kind === 'system') return true;
  if (p.actor.kind === 'agent') return false;
  return can(p, PrivacyManageCapability) || sameSubject(subjectOf(p), subjectOfRow(r));
}
