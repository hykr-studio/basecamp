import type { AuthorizeResult, DecisionDetails } from '@hykr/contracts';

/**
 * Copies only the four detail fields, and only the ones that are set. Passing a whole
 * decision as `details` (say, an earlier one, to keep its level) can never change the
 * decision, rule or reason of the new one.
 */
const pickDetails = (details?: DecisionDetails): DecisionDetails => {
  const out: DecisionDetails = {};
  if (!details) return out;
  if (details.level !== undefined) out.level = details.level;
  if (details.approver !== undefined) out.approver = details.approver;
  if (details.amount !== undefined) out.amount = details.amount;
  if (details.undoMs !== undefined) out.undoMs = details.undoMs;
  return out;
};

/**
 * Helpers for rules and command authorize functions. `details` says what is at stake (the
 * application's approval level), who decides (approver), the amount and the undo window, when
 * the decision knows them. Only those four fields are read from it: the decision, rule and
 * reason are always the helper's own.
 */
export const allow = (rule: string, reason = rule, details?: DecisionDetails): AuthorizeResult => ({
  ...pickDetails(details),
  decision: 'allow',
  rule,
  reason,
});
export const deny = (rule: string, reason: string, details?: DecisionDetails): AuthorizeResult => ({
  ...pickDetails(details),
  decision: 'deny',
  rule,
  reason,
});
export const needsApproval = (
  rule: string,
  reason: string,
  details?: DecisionDetails,
): AuthorizeResult => ({
  ...pickDetails(details),
  decision: 'needs_approval',
  rule,
  reason,
});

/**
 * An action at one of the application's approval levels: allowed as far as this rule goes, and
 * the level's policy (with the business's settings) then says whether it waits or runs, and for
 * how long it can be undone. `rule` and `reason` say why, on the approval card when it waits.
 * A level never loosens a refusal or an explicit `needsApproval`.
 */
export const atLevel = (
  level: string,
  rule: string,
  reason = rule,
  details?: Omit<DecisionDetails, 'level'>,
): AuthorizeResult => ({ ...pickDetails(details), level, decision: 'allow', rule, reason });

/**
 * Thrown when a rule refuses inside a write (an entity rule hit from a command's run).
 * runWrite audits it after the rollback and answers 403.
 */
export class RuleDenied extends Error {
  constructor(readonly result: AuthorizeResult) {
    super(result.reason);
  }
}
