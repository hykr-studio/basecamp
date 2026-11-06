import { z } from 'zod';
import { Money } from './framework/money.js';
import { Assurance } from './principal.js';
import { Channel } from './voice.js';

/**
 * Who decides a parked action:
 * - 'requester': the person it is for (their own assistant's request);
 * - `{ capability }`: anyone in the business holding it, never the requester;
 * - `{ userId }`: one named person, never the requester;
 * - `{ band }`: the approver the business's settings name for the amount's band
 *   (`approvals.bands[band]`).
 */
export const ApproverBy = z.union([
  z.literal('requester'),
  z.object({ capability: z.string() }).strict(),
  z.object({ userId: z.string() }).strict(),
  z.object({ band: z.string() }).strict(),
]);
export type ApproverBy = z.infer<typeof ApproverBy>;

/** Who must decide a parked action, where they may, and how surely we must know them. */
export const Approver = z.object({
  by: ApproverBy.optional(),
  /** Where it may be decided (['app'] for anything that cannot be taken back). */
  channels: z.array(Channel).optional(),
  /** How sure we must be of the decider ('session': signed in). */
  minAssurance: Assurance.optional(),
});
export type Approver = z.infer<typeof Approver>;

export const AuthorizeResult = z.object({
  decision: z.enum(['allow', 'deny', 'needs_approval']),
  rule: z.string(),
  reason: z.string(),
  /**
   * What is at stake: the name of an approval level the application declares
   * (`defineApprovalLevel`). Levels are ordered by rank, and where several decisions meet the
   * highest rank wins. What each level means, which actions get it and who decides it is the
   * application's policy, never the framework's.
   */
  level: z.string().optional(),
  /** Who decides it, when the decision names them (an approver per amount band). */
  approver: Approver.optional(),
  /** The amount it moves: whole minor units and the currency. */
  amount: Money.optional(),
  /** How long the person can still undo it, in milliseconds (the decision's undo window). */
  undoMs: z.number().int().min(0).optional(),
});
export type AuthorizeResult = z.infer<typeof AuthorizeResult>;

/** The optional parts of a decision: what is at stake, who decides, the amount, the undo window. */
export type DecisionDetails = Pick<AuthorizeResult, 'level' | 'approver' | 'amount' | 'undoMs'>;
