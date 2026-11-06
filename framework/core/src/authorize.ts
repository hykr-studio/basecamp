import type { AuthorizeResult, DecisionDetails } from '@hykr/contracts';

/**
 * Helpers for rules and command authorize functions. `details` says what is at stake (tier),
 * who decides (approver), the amount and the undo window, when the decision knows them.
 */
export const allow = (rule: string, reason = rule, details?: DecisionDetails): AuthorizeResult => ({
  decision: 'allow',
  rule,
  reason,
  ...details,
});
export const deny = (rule: string, reason: string, details?: DecisionDetails): AuthorizeResult => ({
  decision: 'deny',
  rule,
  reason,
  ...details,
});
export const needsApproval = (
  rule: string,
  reason: string,
  details?: DecisionDetails,
): AuthorizeResult => ({
  decision: 'needs_approval',
  rule,
  reason,
  ...details,
});

/**
 * Thrown when a rule refuses inside a write (an entity rule hit from a command's run).
 * runWrite audits it after the rollback and answers 403.
 */
export class RuleDenied extends Error {
  constructor(readonly result: AuthorizeResult) {
    super(result.reason);
  }
}
