import { type AuthorizeResult, rankOf } from '@hykr/contracts';

const rank = { allow: 0, needs_approval: 1, deny: 2 } as const;

const most = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * The stricter of two decisions: deny beats needs_approval beats allow, so combining never
 * loosens. The winner keeps its decision, rule and reason; between two decisions of the same
 * kind, the one at the higher-ranked approval level wins (its rule says why it is at stake), and
 * on a tie the first. What is at stake adds up: the higher-ranked level (`rankOf`: an undeclared
 * level ranks above every declared one) and the longer undo window of both. Amount and approver
 * are the winner's, or the other's when both are the same kind of decision. A null is no opinion.
 */
export function strongerDecision(
  a: AuthorizeResult | null | undefined,
  b: AuthorizeResult | null | undefined,
): AuthorizeResult | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const higher = rankOf(b.level) > rankOf(a.level);
  const [win, other] =
    rank[b.decision] > rank[a.decision] || (b.decision === a.decision && higher) ? [b, a] : [a, b];
  const same = win.decision === other.decision;
  const out: AuthorizeResult = { decision: win.decision, rule: win.rule, reason: win.reason };
  const level = higher ? b.level : (a.level ?? b.level);
  if (level !== undefined) out.level = level;
  const undoMs = most(win.undoMs, other.undoMs);
  if (undoMs !== undefined) out.undoMs = undoMs;
  const amount = win.amount ?? (same ? other.amount : undefined);
  if (amount !== undefined) out.amount = amount;
  const approver = win.approver ?? (same ? other.approver : undefined);
  if (approver !== undefined) out.approver = approver;
  return out;
}
