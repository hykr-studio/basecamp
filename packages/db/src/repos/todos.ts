import { and, eq } from 'drizzle-orm';
import type { Database } from '../database.js';
import { approvals, todos } from '../schema/app.js';
import { type WriteCtx, writeAudit } from './audit.js';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type ApprovalRequest = {
  ownerId: string;
  action: string;
  rule: string;
  reason: string;
  resourceType: string;
  resourceId: string;
  payload?: unknown;
};

type ApprovalRow = typeof approvals.$inferSelect;

export function todoRepo(db: Database) {
  return {
    listFor(ownerId: string) {
      return db.select().from(todos).where(eq(todos.ownerId, ownerId)).orderBy(todos.createdAt);
    },

    async findFor(ownerId: string, id: string) {
      const [row] = await db
        .select()
        .from(todos)
        .where(and(eq(todos.ownerId, ownerId), eq(todos.id, id)));
      return row;
    },

    create(ownerId: string, input: { title: string; dueOn?: string | null }, ctx: WriteCtx) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(todos)
          .values({ ownerId, title: input.title, dueOn: input.dueOn ?? null })
          .returning();
        await writeAudit(tx, {
          ...ctx,
          action: 'todo.create',
          resourceType: 'todo',
          resourceId: row.id,
          after: row,
        });
        return row;
      });
    },

    update(
      ownerId: string,
      id: string,
      input: { title?: string; done?: boolean; dueOn?: string | null },
      ctx: WriteCtx,
    ) {
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(todos)
          .where(and(eq(todos.ownerId, ownerId), eq(todos.id, id)));
        if (!before) return undefined;

        const [row] = await tx
          .update(todos)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.done !== undefined ? { done: input.done } : {}),
            ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(todos.ownerId, ownerId), eq(todos.id, id)))
          .returning();
        await writeAudit(tx, {
          ...ctx,
          action: 'todo.update',
          resourceType: 'todo',
          resourceId: row.id,
          before,
          after: row,
        });
        return row;
      });
    },

    remove(ownerId: string, id: string, ctx: WriteCtx) {
      return db.transaction(async (tx) => {
        const [before] = await tx
          .delete(todos)
          .where(and(eq(todos.ownerId, ownerId), eq(todos.id, id)))
          .returning();
        if (!before) return undefined;
        await writeAudit(tx, {
          ...ctx,
          action: 'todo.delete',
          resourceType: 'todo',
          resourceId: before.id,
          before,
        });
        return before;
      });
    },

    /** Record a refusal, so the trail shows the limit held even though no row changed. */
    auditOnly(action: string, resourceId: string | null, ctx: WriteCtx) {
      return writeAudit(db, {
        ...ctx,
        action,
        resourceType: 'todo',
        resourceId,
        outcome: 'denied',
      });
    },

    requestApproval(input: ApprovalRequest, ctx: WriteCtx) {
      return db.transaction(async (tx) => {
        const [approval] = await tx
          .insert(approvals)
          .values({
            ownerId: input.ownerId,
            action: input.action,
            rule: input.rule,
            reason: input.reason,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            payload: input.payload ?? null,
            status: 'pending',
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
          })
          .returning();
        await writeAudit(tx, {
          ...ctx,
          action: 'approval.request',
          resourceType: 'approval',
          resourceId: approval.id,
          outcome: 'needs_approval',
          after: approval,
        });
        return approval;
      });
    },

    pendingApprovalsFor(ownerId: string) {
      return db
        .select()
        .from(approvals)
        .where(and(eq(approvals.ownerId, ownerId), eq(approvals.status, 'pending')))
        .orderBy(approvals.createdAt);
    },

    async findApprovalFor(ownerId: string, id: string) {
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, id)));
      return row;
    },

    /**
     * Mark a pending approval approved, rejected, or expired.
     * An approval past expiresAt is expired even when the caller said yes.
     * Approving a parked delete removes that owner's to-do in the same transaction.
     */
    decideApproval(approval: ApprovalRow, approve: boolean, ctx: WriteCtx) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, approval.id))
          .for('update');
        if (!current || current.status !== 'pending') return current;

        const now = new Date();
        const status = current.expiresAt <= now ? 'expired' : approve ? 'approved' : 'rejected';
        const [updated] = await tx
          .update(approvals)
          .set({ status, decidedAt: now })
          .where(eq(approvals.id, current.id))
          .returning();

        if (status === 'approved' && current.action === 'todo.delete' && current.resourceId) {
          const [before] = await tx
            .delete(todos)
            .where(and(eq(todos.id, current.resourceId), eq(todos.ownerId, current.ownerId)))
            .returning();
          await writeAudit(tx, {
            ...ctx,
            action: 'todo.delete',
            resourceType: 'todo',
            resourceId: current.resourceId,
            before: before ?? null,
          });
        }

        await writeAudit(tx, {
          ...ctx,
          action: `approval.${status}`,
          resourceType: 'approval',
          resourceId: current.id,
          before: current,
          after: updated,
        });
        return updated;
      });
    },
  };
}
