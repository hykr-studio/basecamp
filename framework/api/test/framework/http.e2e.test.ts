// The API's own HTTP setup (V11, `configureHttp`): TRUST_PROXY says which proxies Express believes
// about the caller's address. Behind a trusted proxy each client is itself: the API's throttle and
// Better Auth's limits count it on its own, instead of everyone behind the balancer sharing one
// bucket. A client's own x-hykr-client-address is replaced on every route, whatever the proxy says.
// (auth-routes.e2e covers the default, no proxy trusted.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trustProxyOf } from '../../dist/infra/http.js';
import { boot, origin, Person, server, shutdown } from '../../dist/testing.js';
import { fixture } from '../fixture/dist/index.js';

const ana = new Person('Ana Proxy');
const bo = new Person('Bo Proxy');

beforeAll(async () => {
  // The API runs behind a proxy on this machine: the tests' requests come from loopback.
  process.env.TRUST_PROXY = 'loopback';
  await boot(fixture);
  for (const p of [ana, bo]) await p.signUp();
});

afterAll(async () => {
  delete process.env.TRUST_PROXY;
  await shutdown();
});

describe('TRUST_PROXY', () => {
  it('reads as Express takes it: off, every proxy, a number of hops, or a list', () => {
    for (const off of [undefined, '', ' ', 'false', 'off', 'OFF', '0', 'no'])
      expect(trustProxyOf(off)).toBe(false);
    expect(trustProxyOf('true')).toBe(true);
    expect(trustProxyOf('on')).toBe(true);
    expect(trustProxyOf('1')).toBe(1);
    expect(trustProxyOf('2')).toBe(2);
    expect(trustProxyOf('loopback, 10.0.0.0/8')).toBe('loopback,10.0.0.0/8');
  });

  it('is applied when the API starts', () => {
    const express = server.app?.getHttpAdapter().getInstance() as { get(n: string): unknown };
    expect(express.get('trust proxy')).toBe('loopback');
  });

  it('behind a trusted proxy, the caller is who it forwarded for; their own header is replaced', async () => {
    const res = await ana.call('GET', '/api/fixture-echo', undefined, {
      'x-forwarded-for': '198.51.100.40',
      'x-hykr-client-address': '203.0.113.40',
    });
    expect(res.body).toEqual({ ip: '198.51.100.40', clientAddress: '198.51.100.40' });
  });
});

describe('Better Auth’s limits behind a trusted proxy', () => {
  const wrong = (forwardedFor: string) =>
    fetch(`${server.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ email: bo.email, password: 'not-the-password' }),
    });

  it('count each client on its own: one locked out is not everyone', async () => {
    process.env.THROTTLE = 'on';
    try {
      const one: number[] = [];
      for (let i = 0; i < 4; i++) one.push((await wrong('198.51.100.41')).status);
      expect(one).toEqual([401, 401, 401, 429]);
      // Another client behind the same proxy still signs in (here: fails its password, not 429).
      expect((await wrong('198.51.100.42')).status).toBe(401);
    } finally {
      process.env.THROTTLE = 'off';
    }
  });
});
