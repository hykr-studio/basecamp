// The integration bus's deployment settings, read from the environment when used (so a test can
// set them before it boots the app):
//   SECRETS_KEY                  seals stored credentials and signing secrets (32+ characters)
//   SECRETS_KEY_PREVIOUS         older keys, comma separated: they only open what they sealed
//   INTEGRATIONS_ALLOWED_HOSTS   host names an endpoint may reach on any address, over http too
//   INTEGRATIONS_TIMEOUT_MS      one delivery's whole request (default 10000)
//   INTEGRATIONS_RETRY_SCHEDULE  waits between tries (default 5s,5m,30m,2h,5h,10h,10h)
import { createHmac, hkdfSync } from 'node:crypto';
import {
  createSecretBox,
  type EgressPolicy,
  SECRET_KEY_MIN_LENGTH,
  type SecretBox,
} from '@hykr/connectors';
import { ServiceUnavailableException } from '@nestjs/common';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

let cached: { key: string; previous: string; box: SecretBox } | undefined;

/** The deployment's secret box, or null when SECRETS_KEY is not set. */
export function secretBox(): SecretBox | null {
  const key = process.env.SECRETS_KEY ?? '';
  const previous = process.env.SECRETS_KEY_PREVIOUS ?? '';
  if (!key) return null;
  if (cached?.key !== key || cached.previous !== previous)
    cached = { key, previous, box: createSecretBox({ key, previous: list(previous) }) };
  return cached.box;
}

/** The box, or 503 `secrets_unavailable`: nothing secret is stored or opened without a key. */
export function requireSecretBox(): SecretBox {
  const box = secretBox();
  if (!box)
    throw new ServiceUnavailableException({
      error: 'unavailable',
      rule: 'secrets_unavailable',
      reason: 'This server has no SECRETS_KEY, so it cannot keep credentials',
    });
  return box;
}

let tagKey: { key: string; bytes: Buffer } | undefined;

/**
 * A fingerprint of a secret value under a key derived from SECRETS_KEY, never a plain hash: what
 * a retry of a write carrying credentials is recognised by, so `app.idempotency` keeps nothing a
 * low-entropy secret could be guessed from. 503 without a key, as sealing is.
 */
export function secretTag(value: unknown): string {
  requireSecretBox();
  const key = process.env.SECRETS_KEY ?? '';
  if (tagKey?.key !== key)
    tagKey = {
      key,
      bytes: Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'basecamp request tag v1', 32)),
    };
  return createHmac('sha256', tagKey.bytes).update(JSON.stringify(value)).digest('base64url');
}

/**
 * At start, so nothing fails on a setting later (after a request was sent): a SECRETS_KEY that is
 * set must be long enough (unset is fine: nothing is sealed), and the retry schedule must parse.
 */
export function checkSettings(): void {
  for (const key of [process.env.SECRETS_KEY ?? '', ...list(process.env.SECRETS_KEY_PREVIOUS)])
    if (key && key.length < SECRET_KEY_MIN_LENGTH)
      throw new Error(
        `SECRETS_KEY (and each SECRETS_KEY_PREVIOUS) must be at least ${SECRET_KEY_MIN_LENGTH} characters: openssl rand -hex 32`,
      );
  try {
    retrySchedule();
  } catch (e) {
    throw new Error(`INTEGRATIONS_RETRY_SCHEDULE: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Where deliveries may go: public addresses over https, plus the allowed hosts. */
export function outboundPolicy(): EgressPolicy {
  const timeout = Number(process.env.INTEGRATIONS_TIMEOUT_MS ?? 10_000);
  return {
    allowHosts: list(process.env.INTEGRATIONS_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
    maxResponseBytes: 64 * 1024,
  };
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** '5s' → 5000. Throws on anything else. */
export function parseDuration(text: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a duration (like 500ms, 5s, 5m or 2h)`);
  return Number(m[1]) * UNITS[m[2]];
}

export const DEFAULT_RETRY_SCHEDULE = '5s,5m,30m,2h,5h,10h,10h';

/** The waits between tries: one try plus one per entry. */
export function retrySchedule(): number[] {
  return list(process.env.INTEGRATIONS_RETRY_SCHEDULE || DEFAULT_RETRY_SCHEDULE).map(parseDuration);
}

/** How long a rotated-out secret keeps signing. */
export const PREVIOUS_SECRET_MS = 24 * 60 * 60 * 1000;

/** Where a sealed value belongs: it opens only for this business and row. */
export const endpointAad = (tenantId: string, id: string) => `endpoint:${tenantId}:${id}`;
export const connectionAad = (tenantId: string, id: string) => `connection:${tenantId}:${id}`;
