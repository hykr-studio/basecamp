import type { AuthorizeResult } from '@hykr/contracts';

const rank = { allow: 0, needs_approval: 1, deny: 2 } as const;

const most = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * The stricter of two decisions: deny beats needs_approval beats allow, so combining never
 * loosens. The winner keeps its decision, rule and reason. What is at stake adds up: the
 * highest tier and the longest undo window of both. Amount and approver are the winner's, or
 * the other's when both are the same kind of decision. A null is no opinion.
 */
export function strongerDecision(
  a: AuthorizeResult | null | undefined,
  b: AuthorizeResult | null | undefined,
): AuthorizeResult | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const [win, other] = rank[b.decision] > rank[a.decision] ? [b, a] : [a, b];
  const same = win.decision === other.decision;
  const out: AuthorizeResult = { decision: win.decision, rule: win.rule, reason: win.reason };
  const tier = most(win.tier, other.tier);
  if (tier !== undefined) out.tier = tier as AuthorizeResult['tier'];
  const undoMs = most(win.undoMs, other.undoMs);
  if (undoMs !== undefined) out.undoMs = undoMs;
  const amount = win.amount ?? (same ? other.amount : undefined);
  if (amount !== undefined) out.amount = amount;
  const approver = win.approver ?? (same ? other.approver : undefined);
  if (approver !== undefined) out.approver = approver;
  return out;
}
