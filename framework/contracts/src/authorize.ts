import { z } from 'zod';
import { Assurance } from './principal.js';
import { Channel } from './voice.js';

/**
 * How much an action puts at stake: 0 a read; 1 an internal write, undoable for a while; 2 a
 * send to a client or vendor, which waits for approval; 3 money, legal or irreversible, which
 * needs a named person to decide.
 */
export const Tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof Tier>;

/** Who must decide a parked action, when the decision names them, and where they may. */
export const Approver = z.object({
  /** One named person. */
  userId: z.string().optional(),
  /** Anyone holding one of these roles in the business. */
  roles: z.array(z.string()).optional(),
  channels: z.array(Channel).optional(),
  minAssurance: Assurance.optional(),
});
export type Approver = z.infer<typeof Approver>;

export const AuthorizeResult = z.object({
  decision: z.enum(['allow', 'deny', 'needs_approval']),
  rule: z.string(),
  reason: z.string(),
  /** What is at stake (see Tier). */
  tier: Tier.optional(),
  /** Who decides it, when the decision names them (an approver per amount band). */
  approver: Approver.optional(),
  /** The amount it moves, in minor units (paise) of the business's currency. */
  amount: z.number().int().optional(),
  /** How long the person can still undo it (tier 1), in milliseconds. */
  undoMs: z.number().int().min(0).optional(),
});
export type AuthorizeResult = z.infer<typeof AuthorizeResult>;

/** The optional parts of a decision: what is at stake, who decides, and the undo window. */
export type DecisionDetails = Pick<AuthorizeResult, 'tier' | 'approver' | 'amount' | 'undoMs'>;
