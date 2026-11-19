// Web push's settings and helpers (W1), without a server.
import { createECDH } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { browserOf, maskEndpoint } from '../../dist/features/push/web.service.js';
import {
  endpointProblem,
  publicKeyOf,
  webPushProblem,
} from '../../dist/features/push/web.settings.js';

const pair = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
};

describe('the VAPID settings', () => {
  it('none set is fine: web push is off', () => {
    expect(webPushProblem({ publicKey: '', privateKey: '', subject: '' })).toBeNull();
  });

  it('a matching pair with a mailto: or https: subject is fine', () => {
    const keys = pair();
    expect(webPushProblem({ ...keys, subject: 'mailto:ops@example.com' })).toBeNull();
    expect(webPushProblem({ ...keys, subject: 'https://example.com/contact' })).toBeNull();
    expect(publicKeyOf(keys.privateKey)).toBe(keys.publicKey);
  });

  it('refuses a partial set, a pair that does not match, a bad key and a bad subject', () => {
    const keys = pair();
    expect(webPushProblem({ ...keys, subject: '' })).toMatch(/Set all of/);
    expect(
      webPushProblem({ ...keys, publicKey: pair().publicKey, subject: 'mailto:a@b.c' }),
    ).toMatch(/is not the public key/);
    expect(webPushProblem({ ...keys, privateKey: 'short', subject: 'mailto:a@b.c' })).toMatch(
      /P-256 private key/,
    );
    expect(webPushProblem({ ...keys, subject: 'ops@example.com' })).toMatch(/mailto: or https:/);
    expect(webPushProblem({ ...keys, subject: 'http://example.com' })).toMatch(/mailto: or https:/);
  });
});

describe('an endpoint', () => {
  afterEach(() => {
    delete process.env.WEB_PUSH_ALLOWED_HOSTS;
  });

  it('is https on a known push service, or a subdomain of one', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGx',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ])
      expect(endpointProblem(ok), ok).toBeNull();
  });

  it('is refused anywhere else, over http, on another port or with credentials', () => {
    expect(endpointProblem('https://example.com/push')).toMatch(/not a known push service/);
    expect(endpointProblem('https://fcm.googleapis.com.example.com/x')).toMatch(/not a known/);
    expect(endpointProblem('https://evilfcm.googleapis.com.io/x')).toMatch(/not a known/);
    expect(endpointProblem('http://fcm.googleapis.com/x')).toMatch(/must be https/);
    expect(endpointProblem('https://fcm.googleapis.com:8443/x')).toMatch(/standard https port/);
    expect(endpointProblem('https://a:b@fcm.googleapis.com/x')).toMatch(/user name/);
    expect(endpointProblem('not a url')).toBe('not a URL');
    expect(endpointProblem('http://localhost:9000/push/a')).toMatch(/not https|must be https/);
  });

  it('may be on a host the deployment allows, over http too', () => {
    process.env.WEB_PUSH_ALLOWED_HOSTS = 'localhost, push.internal.test';
    expect(endpointProblem('http://localhost:9000/push/a')).toBeNull();
    expect(endpointProblem('https://push.internal.test/a')).toBeNull();
    expect(endpointProblem('ftp://localhost/a')).toBe('not an http URL');
  });
});

describe('what a person sees of their browsers', () => {
  it('the endpoint shortened to its host and a few characters of its id', () => {
    expect(maskEndpoint('https://fcm.googleapis.com/fcm/send/dXk3ZmFiYzEyMw')).toBe(
      'fcm.googleapis.com/dXk3Zm…',
    );
    // Never more than half of a short id.
    expect(maskEndpoint('https://web.push.apple.com/abcd')).toBe('web.push.apple.com/ab…');
  });

  it("the browser's name and system, never the whole User-Agent", () => {
    const ua = {
      chromeMac:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      edgeWin:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      safariIphone:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    };
    expect(browserOf(ua.chromeMac)).toBe('Chrome on macOS');
    expect(browserOf(ua.edgeWin)).toBe('Edge on Windows');
    expect(browserOf(ua.firefoxLinux)).toBe('Firefox on Linux');
    expect(browserOf(ua.safariIphone)).toBe('Safari on iOS');
    expect(browserOf(undefined)).toBeUndefined();
    expect(browserOf('curl/8.0')).toBeUndefined();
  });
});
