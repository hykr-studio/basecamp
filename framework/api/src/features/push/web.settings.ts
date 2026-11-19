// Web push's settings, read from the environment when used (never when a module loads):
//   WEB_PUSH_PUBLIC_KEY     the VAPID public key: a P-256 point, base64url (basecamp webpush keys)
//   WEB_PUSH_PRIVATE_KEY    its private key: 32 bytes, base64url
//   WEB_PUSH_SUBJECT        who sends, for the push services: mailto:… or https://…
//   WEB_PUSH_ALLOWED_HOSTS  host names an endpoint may also be on, over http too (development, tests)
//   WEB_PUSH_TIMEOUT_MS     one send to one browser, connect to last byte (default 10000)
// Without the three keys, web push is off: its notifications go to their next channel.
import { createECDH } from 'node:crypto';
import type { EgressPolicy } from '@hykr/connectors';
import { secretBox } from '../integrations/settings.js';

const env = process.env;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const read = () => ({
  publicKey: env.WEB_PUSH_PUBLIC_KEY?.trim() ?? '',
  privateKey: env.WEB_PUSH_PRIVATE_KEY?.trim() ?? '',
  subject: env.WEB_PUSH_SUBJECT?.trim() ?? '',
});

/** The public key a private key makes, base64url; null when it is not a P-256 private key. */
export function publicKeyOf(privateKey: string): string | null {
  const bytes = Buffer.from(privateKey, 'base64url');
  if (bytes.length !== 32) return null;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(bytes);
    return ecdh.getPublicKey().toString('base64url');
  } catch {
    return null;
  }
}

/**
 * What is wrong with the web push settings, or null. None set is fine (web push is off); some
 * set is not; the keys must be a pair; the subject a mailto: or https: address.
 */
export function webPushProblem(v = read()): string | null {
  const set = [v.publicKey, v.privateKey, v.subject].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3)
    return 'Set all of WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT, or none (basecamp webpush keys)';
  const derived = publicKeyOf(v.privateKey);
  if (!derived) return 'WEB_PUSH_PRIVATE_KEY must be a P-256 private key, base64url (32 bytes)';
  if (Buffer.from(v.publicKey, 'base64url').toString('base64url') !== derived)
    return 'WEB_PUSH_PUBLIC_KEY is not the public key of WEB_PUSH_PRIVATE_KEY';
  if (!/^mailto:\S+@\S+$/.test(v.subject) && !/^https:\/\/\S+$/.test(v.subject))
    return 'WEB_PUSH_SUBJECT must be a mailto: or https: address';
  return null;
}

/** Refuse to start with web push settings that cannot work (assertConfig). */
export function checkWebPushSettings() {
  const problem = webPushProblem();
  if (problem) throw new Error(problem);
}

/**
 * The VAPID details, or null when web push is off: no keys, keys that are wrong, or no
 * SECRETS_KEY (the browsers' keys are kept sealed).
 */
export function vapid(): Vapid | null {
  const v = read();
  if (!v.publicKey || webPushProblem(v)) return null;
  try {
    return secretBox() ? v : null;
  } catch {
    // A SECRETS_KEY too short to use: the integrations' start check says so.
    return null;
  }
}

/** The push services a browser's endpoint may be on (https only), and their subdomains. */
const PUSH_SERVICES = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Opera, Samsung
  'updates.push.services.mozilla.com', // Firefox
  'push.services.mozilla.com',
  'web.push.apple.com', // Safari
  'notify.windows.com', // Edge (WNS): wns2-<region>.notify.windows.com
];

/** Hosts an endpoint may also be on, over plain http too: a stand-in in development or tests. */
export const extraHosts = () => list(env.WEB_PUSH_ALLOWED_HOSTS);

/**
 * May a browser register this endpoint? https on a known push service (or a host the
 * deployment allows), no user name or password: the server never posts to an address a browser
 * made up. The egress guard checks the address again when it sends.
 */
export function endpointProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.username || url.password) return 'an endpoint may not carry a user name or password';
  const host = url.hostname.toLowerCase();
  if (extraHosts().includes(host))
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'not an http URL';
  if (url.protocol !== 'https:') return 'an endpoint must be https';
  if (url.port && url.port !== '443') return 'an endpoint must be on the standard https port';
  if (!PUSH_SERVICES.some((s) => host === s || host.endsWith(`.${s}`)))
    return `${host} is not a known push service`;
  return null;
}

/** How a send to a browser goes out: under the egress guard, the extra hosts let through. */
export function webPushPolicy(): EgressPolicy {
  const ms = Number(env.WEB_PUSH_TIMEOUT_MS);
  return {
    allowHosts: extraHosts(),
    timeoutMs: Number.isFinite(ms) && ms > 0 ? ms : 10_000,
    maxResponseBytes: 8 * 1024,
  };
}
