import { z } from 'zod';
import { Money } from './money.js';

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'failed']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** A level as an approval shows it: its name, and its rank and label when it is still declared. */
export const ApprovalLevelInfo = z.object({
  name: z.string(),
  rank: z.number().int().optional(),
  label: z.object({ en: z.string(), hi: z.string(), te: z.string() }).optional(),
});
export type ApprovalLevelInfo = z.infer<typeof ApprovalLevelInfo>;

export const Decider = z.object({
  by: z.enum(['requester', 'person', 'capability']),
  userId: z.string().optional(),
  capability: z.string().optional(),
});
export type Decider = z.infer<typeof Decider>;

/** Something an agent asked to do that waits for its owner. Any command can be parked. */
export const Approval = z.object({
  id: z.string(),
  /** The command, e.g. todo.delete or meeting.close. */
  action: z.string(),
  rule: z.string(),
  reason: z.string(),
  status: ApprovalStatus,
  /** What the person is asked to approve, e.g. Close "Site review" with 1 note and 3 to-dos. */
  summary: z.string().nullable(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  /** The parked input, so the person can read exactly what will run (e.g. a drafted close). */
  input: z.unknown(),
  /** Who asked: the person, or the assistant acting for them. */
  requestedBy: z.enum(['user', 'agent', 'system', 'guest']),
  expiresAt: z.iso.datetime(),
  /** Set when an approved replay was refused, e.g. the meeting was closed meanwhile. */
  failureReason: z.string().nullable(),
  /** When the person decided it (null while it waits), so a client can say "since approved at 2:38". */
  decidedAt: z.iso.datetime().nullable().optional(),
  /** What is at stake: the application's approval level it parked at, when it named one. */
  level: ApprovalLevelInfo.nullable().optional(),
  /** The amount it moves, when the decision said. */
  amount: Money.nullable().optional(),
  /**
   * Whether the one reading it may decide it. The requester can open their own request when
   * someone else decides it: then false.
   */
  canDecide: z.boolean().optional(),
  /** Who decides it: the requester, one named person, or the holders of a capability. */
  decider: Decider.optional(),
});
export type Approval = z.infer<typeof Approval>;

/**
 * A write that ran with an undo window: the person it was for can undo it with
 * `POST /api/undo/:id` until `until`.
 */
export const UndoTicket = z.object({ id: z.string(), until: z.iso.datetime() });
export type UndoTicket = z.infer<typeof UndoTicket>;

/** Every write, generated or hand-written, answers with one of these. */
export function writeResult<V extends z.ZodType>(value: V) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('done'), value, undo: UndoTicket.optional() }),
    z.object({ status: z.literal('needs_approval'), approval: Approval }),
  ]);
}
export type WriteResult<V = unknown> =
  | { status: 'done'; value: V; undo?: UndoTicket }
  | { status: 'needs_approval'; approval: Approval };

/** What undoing a write answers. */
export const UndoResult = z.object({
  id: z.string(),
  undone: z.literal(true),
  /** The write that was undone: 'todo.update'. */
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
});
export type UndoResult = z.infer<typeof UndoResult>;
