// Signed webhooks in the Standard Webhooks form (https://www.standardwebhooks.com): three headers,
// an HMAC-SHA256 over "<id>.<timestamp>.<body>", and secrets written `whsec_<base64>`. Receivers
// verify it with any Standard Webhooks library, or with `verifyWebhook` below.
import { randomBytes } from 'node:crypto';
import { hmacDigest, safeEqual } from './hmac.js';

const PREFIX = 'whsec_';

/** The headers a signed request carries. */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;

/** How far a request's timestamp may be from now, either way: older ones are replays. */
export const DEFAULT_TOLERANCE_SEC = 300;

/** A new signing secret: `whsec_` and 32 random bytes in base64. */
export function generateWebhookSecret(): string {
  return `${PREFIX}${randomBytes(32).toString('base64')}`;
}

/** The HMAC key a secret stands for: the bytes after `whsec_`, or the text itself without it. */
function keyOf(secret: string): Buffer {
  if (secret.startsWith(PREFIX)) return Buffer.from(secret.slice(PREFIX.length), 'base64');
  return Buffer.from(secret, 'utf8');
}

const content = (id: string, timestamp: number, body: string | Buffer) =>
  Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`),
    Buffer.isBuffer(body) ? body : Buffer.from(body),
  ]);

/** One `v1,<signature>` entry for this secret. */
function signatureFor(secret: string, id: string, timestamp: number, body: string | Buffer) {
  return `v1,${hmacDigest(keyOf(secret), content(id, timestamp, body), { encoding: 'base64' })}`;
}

/**
 * The headers for one request. Several secrets (a rotation in progress) give several
 * space-separated signatures; a receiver accepts the request when any one matches.
 */
export function signWebhook(a: {
  secrets: readonly string[];
  /** The message's id: the same on every retry, so a receiver can drop repeats. */
  id: string;
  /** Seconds since the epoch. Default: now. */
  timestamp?: number;
  body: string | Buffer;
}): Record<(typeof WEBHOOK_HEADERS)[keyof typeof WEBHOOK_HEADERS], string> {
  if (!a.secrets.length) throw new Error('signWebhook needs at least one secret');
  if (!/^[^\s.]{1,256}$/.test(a.id)) throw new Error(`signWebhook: "${a.id}" is not a message id`);
  const timestamp = a.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    [WEBHOOK_HEADERS.id]: a.id,
    [WEBHOOK_HEADERS.timestamp]: String(timestamp),
    [WEBHOOK_HEADERS.signature]: a.secrets
      .map((s) => signatureFor(s, a.id, timestamp, a.body))
      .join(' '),
  };
}

type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
};

export type WebhookVerification =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale' | 'bad_signature' };

/**
 * Is this request signed with `secret`, and recent? Headers are looked up by their lower-case
 * names (Node's request headers are). `body` must be the exact bytes received.
 */
export function verifyWebhook(a: {
  secret: string;
  headers: Headers;
  body: string | Buffer;
  toleranceSec?: number;
  /** Milliseconds since the epoch. Default: now. */
  now?: number;
}): WebhookVerification {
  const id = header(a.headers, WEBHOOK_HEADERS.id);
  const stamp = header(a.headers, WEBHOOK_HEADERS.timestamp);
  const signatures = header(a.headers, WEBHOOK_HEADERS.signature);
  if (!a.secret || !id || !stamp || !signatures) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(stamp)) return { ok: false, reason: 'bad_timestamp' };
  const timestamp = Number(stamp);
  const now = Math.floor((a.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (a.toleranceSec ?? DEFAULT_TOLERANCE_SEC))
    return { ok: false, reason: 'stale' };
  const expected = signatureFor(a.secret, id, timestamp, a.body);
  const match = signatures
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .some((s) => safeEqual(s, expected));
  return match ? { ok: true, id, timestamp } : { ok: false, reason: 'bad_signature' };
}
