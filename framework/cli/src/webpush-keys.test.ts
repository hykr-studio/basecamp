import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vapidEnv, vapidKeys } from './webpush-keys.js';

describe('basecamp webpush keys', () => {
  it('makes a P-256 pair: the public key is the private key’s point', () => {
    const { publicKey, privateKey } = vapidKeys();
    expect(Buffer.from(privateKey, 'base64url')).toHaveLength(32);
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    expect(ecdh.getPublicKey().toString('base64url')).toBe(publicKey);
  });

  it('a new pair each time, as .env lines', () => {
    expect(vapidKeys().privateKey).not.toBe(vapidKeys().privateKey);
    const lines = vapidEnv().split('\n');
    expect(lines.filter((l) => /^WEB_PUSH_(PUBLIC|PRIVATE)_KEY=[\w-]+$/.test(l))).toHaveLength(2);
    expect(lines).toContain('WEB_PUSH_SUBJECT=mailto:you@example.com');
  });
});
