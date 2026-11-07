// Secrets at rest: AES-256-GCM under a key derived from a deployment secret (SECRETS_KEY).
// A sealed value is `v1.<key id>.<iv>.<tag>.<ciphertext>` (base64url parts). Its associated data
// names the row it belongs to, so a sealed value copied to another row or business does not open.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/** The shortest deployment secret accepted, as for the server's other secrets. */
export const SECRET_KEY_MIN_LENGTH = 32;

const VERSION = 'v1';
const INFO = 'hykr.secret-box.v1';

export class SecretBoxError extends Error {}

interface Key {
  id: string;
  bytes: Buffer;
}

function deriveKey(secret: string): Key {
  if (secret.length < SECRET_KEY_MIN_LENGTH)
    throw new SecretBoxError(
      `A secrets key must be at least ${SECRET_KEY_MIN_LENGTH} characters (openssl rand -hex 32)`,
    );
  const bytes = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), INFO, 32),
  );
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  return { id, bytes };
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export interface SecretBox {
  /** The current key's id, as it appears in what `seal` returns. */
  readonly keyId: string;
  /** Encrypt `plain` for the row `aad` names ('connection:<tenant>:<id>'). */
  seal(plain: string, aad: string): string;
  /** Decrypt a sealed value for the same row. Throws SecretBoxError if it was not sealed for it. */
  open(sealed: string, aad: string): string;
}

/**
 * A box for the deployment's key. `previous` keys only open values sealed before a key change;
 * everything new is sealed with `key`.
 */
export function createSecretBox(options: { key: string; previous?: readonly string[] }): SecretBox {
  const current = deriveKey(options.key);
  const keys = new Map<string, Key>([[current.id, current]]);
  for (const old of options.previous ?? []) {
    const k = deriveKey(old);
    if (!keys.has(k.id)) keys.set(k.id, k);
  }
  return {
    keyId: current.id,
    seal(plain, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current.bytes, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [VERSION, current.id, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
    },
    open(sealed, aad) {
      const [version, keyId, iv, tag, ct] = sealed.split('.');
      if (version !== VERSION || !keyId || !iv || !tag || ct === undefined)
        throw new SecretBoxError('Not a sealed value');
      const key = keys.get(keyId);
      if (!key) throw new SecretBoxError(`Sealed with an unknown key (${keyId})`);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key.bytes, unb64(iv));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(unb64(tag));
        return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('The sealed value does not open here');
      }
    },
  };
}
