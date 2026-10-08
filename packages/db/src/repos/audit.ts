import type { DbOrTx } from '../database.js';
import { events } from '../schema/audit.js';

/** Who is writing, carried into every audit row. */
export type WriteCtx = {
  actorKind: 'user' | 'agent' | 'contact' | 'system';
  actorId: string;
  actingFor?: string | null;
  /** The business it happened in, and whom for: a person ('user') or a contact ('contact'). */
  tenantId?: string | null;
  subjectKind?: string | null;
  runId?: string | null;
  requestId?: string | null;
  approvedBy?: string | null;
  agentVersion?: string | null;
  /** How the turn reached the assistant: app, voice or whatsapp. */
  channel?: string | null;
  rule?: string | null;
  reason?: string | null;
};

export type AuditInput = WriteCtx & {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** committed for a write, denied for a refusal, needs_approval while a person still has to decide. */
  outcome?: 'committed' | 'denied' | 'needs_approval';
  before?: unknown;
  after?: unknown;
};

/** Insert one audit.events row. Pass the db, or the transaction the change already runs in. */
export async function writeAudit(tx: DbOrTx, input: AuditInput) {
  const [row] = await tx
    .insert(events)
    .values({
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      actorKind: input.actorKind,
      actorId: input.actorId,
      actingFor: input.actingFor ?? null,
      tenantId: input.tenantId ?? null,
      subjectKind: input.subjectKind ?? null,
      runId: input.runId ?? null,
      requestId: input.requestId ?? null,
      approvedBy: input.approvedBy ?? null,
      agentVersion: input.agentVersion ?? null,
      channel: input.channel ?? null,
      rule: input.rule ?? null,
      reason: input.reason ?? null,
      outcome: input.outcome ?? 'committed',
      before: input.before ?? null,
      after: input.after ?? null,
    })
    .returning();
  return row;
}
