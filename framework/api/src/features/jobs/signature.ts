// The framework's callback signature: `x-job-signature: t=<unix seconds>,v1=<hex>`, where the
// hex is HMAC-SHA256(job secret, "<t>.<raw body>"). Nothing here loads Nest.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header a service signs its callbacks in. */
export const JOB_SIGNATURE_HEADER = 'x-job-signature';

const mac = (secret: string, t: number, body: Buffer | string) =>
  createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');

/** The header value for this body, signed now (or at `t`, in unix seconds). */
export function signJobCallback(
  secret: string,
  body: Buffer | string,
  t = Math.floor(Date.now() / 1000),
): string {
  return `t=${t},v1=${mac(secret, t, body)}`;
}

export type JobSignatureCheck =
  | { ok: true; t: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'stale' };

/**
 * Is this the body the job's service signed, recently? The HMAC is compared in constant time;
 * `t` must be within `toleranceS` of now, either way.
 */
export function verifyJobCallback(
  secret: string,
  body: Buffer | string,
  header: string | string[] | undefined,
  o: { toleranceS: number; now?: number },
): JobSignatureCheck {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return { ok: false, reason: 'missing' };
  const parts = new Map<string, string[]>();
  for (const part of value.split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) return { ok: false, reason: 'malformed' };
    const key = part.slice(0, at).trim();
    parts.set(key, [...(parts.get(key) ?? []), part.slice(at + 1).trim()]);
  }
  const t = Number(parts.get('t')?.[0]);
  const given = parts.get('v1') ?? [];
  if (!Number.isInteger(t) || t <= 0 || !given.length) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(mac(secret, t, body), 'hex');
  // Any one v1 may match (a service rotating its scheme sends two).
  const matches = given.some((hex) => {
    if (!/^[0-9a-f]+$/i.test(hex)) return false;
    const actual = Buffer.from(hex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!matches) return { ok: false, reason: 'mismatch' };
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > o.toleranceS) return { ok: false, reason: 'stale' };
  return { ok: true, t };
}
