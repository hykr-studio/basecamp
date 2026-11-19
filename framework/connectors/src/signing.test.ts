import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacDigest, safeEqual, verifyHmac } from './hmac.js';
import { createSecretBox, SecretBoxError } from './secret-box.js';
import { generateWebhookSecret, signWebhook, verifyWebhook } from './signature.js';

describe('HMAC helpers', () => {
  const secret = 'a-shared-secret';
  const body = Buffer.from('{"hello":"world"}');
  const hex = createHmac('sha256', secret).update(body).digest('hex');

  it('digests as hex, base64 or base64url', () => {
    expect(hmacDigest(secret, body)).toBe(hex);
    expect(hmacDigest(secret, body, { encoding: 'base64' })).toBe(
      createHmac('sha256', secret).update(body).digest('base64'),
    );
    expect(hmacDigest(secret, body, { algorithm: 'sha512', encoding: 'base64url' })).toBe(
      createHmac('sha512', secret).update(body).digest('base64url'),
    );
  });

  it('verifies a signature with its prefix, hex in either case', () => {
    expect(
      verifyHmac({ secret, payload: body, signature: `sha256=${hex}`, prefix: 'sha256=' }),
    ).toBe(true);
    expect(
      verifyHmac({
        secret,
        payload: body,
        signature: `sha256=${hex.toUpperCase()}`,
        prefix: 'sha256=',
      }),
    ).toBe(true);
    expect(verifyHmac({ secret, payload: body, signature: [hex, 'other'] })).toBe(true);
  });

  it('refuses a changed body, a wrong prefix, a short digest, a missing secret or signature', () => {
    const signature = `sha256=${hex}`;
    expect(verifyHmac({ secret, payload: 'changed', signature, prefix: 'sha256=' })).toBe(false);
    expect(verifyHmac({ secret, payload: body, signature, prefix: 'sha1=' })).toBe(false);
    expect(verifyHmac({ secret, payload: body, signature: hex.slice(0, 10) })).toBe(false);
    expect(verifyHmac({ secret: '', payload: body, signature: hex })).toBe(false);
    expect(verifyHmac({ secret, payload: body, signature: undefined })).toBe(false);
    expect(verifyHmac({ secret: 'other', payload: body, signature: hex })).toBe(false);
  });

  it('compares unequal lengths as unequal', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(Buffer.from('abc'), 'abc')).toBe(true);
  });
});

describe('Standard Webhooks signatures', () => {
  it('matches the published test vector', () => {
    const headers = signWebhook({
      secrets: ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: 1614265330,
      body: '{"test": 2432232314}',
    });
    expect(headers['webhook-signature']).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('signs and verifies, with the timestamp within the tolerance either way', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const now = Date.UTC(2030, 0, 1);
    const body = JSON.stringify({ type: 'task.created', data: { id: 1 } });
    const headers = signWebhook({ secrets: [secret], id: 'msg_1', timestamp: now / 1000, body });
    expect(verifyWebhook({ secret, headers, body, now })).toEqual({
      ok: true,
      id: 'msg_1',
      timestamp: now / 1000,
    });
    expect(verifyWebhook({ secret, headers, body, now: now + 299_000 }).ok).toBe(true);
    expect(verifyWebhook({ secret, headers, body, now: now + 301_000 })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verifyWebhook({ secret, headers, body, now: now - 301_000 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('carries one signature per secret during a rotation; either verifies', () => {
    const [a, b] = [generateWebhookSecret(), generateWebhookSecret()];
    const now = Date.now();
    const headers = signWebhook({ secrets: [a, b], id: 'msg_2', body: 'x' });
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verifyWebhook({ secret: a, headers, body: 'x', now }).ok).toBe(true);
    expect(verifyWebhook({ secret: b, headers, body: 'x', now }).ok).toBe(true);
    expect(verifyWebhook({ secret: generateWebhookSecret(), headers, body: 'x', now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a changed body, missing headers and a bad timestamp', () => {
    const secret = generateWebhookSecret();
    const headers = signWebhook({ secrets: [secret], id: 'msg_3', body: 'a' });
    expect(verifyWebhook({ secret, headers, body: 'b' }).ok).toBe(false);
    const { 'webhook-id': _id, ...noId } = headers;
    expect(verifyWebhook({ secret, headers: noId, body: 'a' })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(
      verifyWebhook({ secret, headers: { ...headers, 'webhook-timestamp': 'soon' }, body: 'a' }),
    ).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('needs a secret and a plain message id', () => {
    expect(() => signWebhook({ secrets: [], id: 'm', body: '' })).toThrow('at least one secret');
    expect(() => signWebhook({ secrets: ['whsec_x'], id: 'a b', body: '' })).toThrow(
      'not a message id',
    );
  });
});

describe('the secret box', () => {
  const key = 'k'.repeat(40);

  it('opens what it sealed for the same row only', () => {
    const box = createSecretBox({ key });
    const sealed = box.seal('the secret', 'endpoint:t1:e1');
    expect(sealed.startsWith(`v1.${box.keyId}.`)).toBe(true);
    expect(sealed).not.toContain('the secret');
    expect(box.open(sealed, 'endpoint:t1:e1')).toBe('the secret');
    expect(() => box.open(sealed, 'endpoint:t2:e1')).toThrow(SecretBoxError);
    expect(box.seal('the secret', 'endpoint:t1:e1')).not.toBe(sealed);
  });

  it('refuses a tampered value, a foreign key and something not sealed', () => {
    const box = createSecretBox({ key });
    const sealed = box.seal('x', 'a');
    const parts = sealed.split('.');
    parts[4] = Buffer.from('y').toString('base64url');
    expect(() => box.open(parts.join('.'), 'a')).toThrow('does not open');
    const other = createSecretBox({ key: 'o'.repeat(40) });
    expect(() => other.open(sealed, 'a')).toThrow('unknown key');
    expect(() => box.open('plain', 'a')).toThrow('Not a sealed value');
  });

  it('opens values sealed with a previous key, and seals with the new one', () => {
    const old = createSecretBox({ key });
    const sealed = old.seal('kept', 'a');
    const now = createSecretBox({ key: 'n'.repeat(40), previous: [key] });
    expect(now.open(sealed, 'a')).toBe('kept');
    expect(now.seal('new', 'a').split('.')[1]).toBe(now.keyId);
    expect(now.keyId).not.toBe(old.keyId);
  });

  it('refuses a short key', () => {
    expect(() => createSecretBox({ key: 'short' })).toThrow('at least 32');
  });
});
