import { hmacDigest, safeEqual } from '@hykr/connectors';

/**
 * An approval button's payload: apr:<approvalId>:<a|r>:<expiresAt>:<hmac>. The HMAC covers the
 * approval, the decision, the expiry and the contact it was sent to, so a button decides once,
 * only before it expires, and only when that contact taps it (a forwarded message is useless).
 */
export type ApprovalDecision = { approvalId: string; approve: boolean; expiresAt: number };

const PREFIX = 'apr';

const mac = (secret: string, d: ApprovalDecision, contactId: string) =>
  hmacDigest(secret, [d.approvalId, d.approve ? 'a' : 'r', d.expiresAt, contactId].join('|'), {
    encoding: 'base64url',
  });

export function signApproval(secret: string, d: ApprovalDecision, contactId: string): string {
  return [PREFIX, d.approvalId, d.approve ? 'a' : 'r', d.expiresAt, mac(secret, d, contactId)].join(
    ':',
  );
}

export const isApprovalPayload = (payload: string) => payload.startsWith(`${PREFIX}:`);

/** The decision a payload carries, if it is genuine, unexpired, and from the contact it was for. */
export function verifyApproval(
  secret: string,
  payload: string,
  contactId: string,
  now = Date.now(),
): { ok: true; decision: ApprovalDecision } | { ok: false; reason: 'invalid' | 'expired' } {
  const [prefix, approvalId, flag, expires, given] = payload.split(':');
  const expiresAt = Number(expires);
  if (prefix !== PREFIX || !approvalId || (flag !== 'a' && flag !== 'r') || !given || !expiresAt)
    return { ok: false, reason: 'invalid' };
  const decision = { approvalId, approve: flag === 'a', expiresAt };
  if (!safeEqual(mac(secret, decision, contactId), given)) return { ok: false, reason: 'invalid' };
  if (now > expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, decision };
}
