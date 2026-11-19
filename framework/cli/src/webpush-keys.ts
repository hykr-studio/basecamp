// basecamp webpush keys: a new VAPID key pair for web push (P-256), as .env lines.
import { generateKeyPairSync } from 'node:crypto';

/** A new pair, base64url: the public key as an uncompressed point, the private key's 32 bytes. */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  if (!pub.x || !pub.y || !priv.d) throw new Error('The key pair has no coordinates');
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
  ]);
  return { publicKey: point.toString('base64url'), privateKey: priv.d };
}

/** What `basecamp webpush keys` prints. */
export function vapidEnv(subject = 'mailto:you@example.com'): string {
  const { publicKey, privateKey } = vapidKeys();
  return [
    '# Web push (VAPID). Keep the private key secret; changing the pair drops every browser.',
    `WEB_PUSH_PUBLIC_KEY=${publicKey}`,
    `WEB_PUSH_PRIVATE_KEY=${privateKey}`,
    `WEB_PUSH_SUBJECT=${subject}`,
  ].join('\n');
}
