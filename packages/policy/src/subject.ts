import { type Principal, type Subject, subjectKey } from '@app/contracts';

/**
 * Whom an action is for: yourself, or whom the agent acts for. The server sets `subject`;
 * older principals (an approval parked before tenants) fall back to their user ids.
 */
export function subjectOf(p: Principal): Subject | null {
  if (p.subject) return p.subject;
  if (p.actor.kind === 'user') return { kind: 'user', userId: p.actor.id };
  if (p.actingFor?.userId) return { kind: 'user', userId: p.actingFor.userId };
  if (p.actingFor?.contactId) return { kind: 'contact', contactId: p.actingFor.contactId };
  return null;
}

/** The person's user id, when the subject has an account. */
export function userIdOf(p: Principal): string | null {
  const s = subjectOf(p);
  return s?.kind === 'user' ? s.userId : null;
}

/** The subject as a key ("user:abc", "contact:xyz"), for locks, idempotency and audit. */
export function subjectKeyOf(p: Principal): string | null {
  const s = subjectOf(p);
  return s ? subjectKey(s) : null;
}
