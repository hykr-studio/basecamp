import { z } from 'zod';

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'failed']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

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
  /** Who asked: the person, or the assistant acting for them. */
  requestedBy: z.enum(['user', 'agent']),
  expiresAt: z.iso.datetime(),
  /** Set when an approved replay was refused, e.g. the meeting was closed meanwhile. */
  failureReason: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

/** Every write, generated or hand-written, answers with one of these. */
export function writeResult<V extends z.ZodType>(value: V) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('done'), value }),
    z.object({ status: z.literal('needs_approval'), approval: Approval }),
  ]);
}
export type WriteResult<V = unknown> =
  | { status: 'done'; value: V }
  | { status: 'needs_approval'; approval: Approval };
