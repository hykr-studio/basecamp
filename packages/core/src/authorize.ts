import type { AuthorizeResult } from '@app/contracts';

/** Helpers for rules and command authorize functions. */
export const allow = (rule: string, reason = rule): AuthorizeResult => ({
  decision: 'allow',
  rule,
  reason,
});
export const deny = (rule: string, reason: string): AuthorizeResult => ({
  decision: 'deny',
  rule,
  reason,
});
export const needsApproval = (rule: string, reason: string): AuthorizeResult => ({
  decision: 'needs_approval',
  rule,
  reason,
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
