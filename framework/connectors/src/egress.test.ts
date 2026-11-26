import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkUrl,
  EgressBlocked,
  EgressTimeout,
  isEgressBlocked,
  isPublicAddress,
  type LookupAll,
  safeRequest,
} from './egress.js';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '[::1]',
    'fe80::1%lo0',
    'localhost',
    'not an ip',
  ])('%s is not public', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '2002:808:808::',
  ])('%s is public', (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe('checkUrl', () => {
  it('allows https to a public name or address', () => {
    expect(checkUrl('https://hooks.example.com/in').ok).toBe(true);
    expect(checkUrl('https://8.8.8.8/in').ok).toBe(true);
  });

  it.each([
    ['ftp://example.com/x', 'only http and https'],
    ['http://example.com/x', 'only https'],
    ['https://user:pw@example.com/x', 'user name or password'],
    ['https://127.0.0.1/x', 'not a public address'],
    ['https://[::1]/x', 'not a public address'],
    ['https://169.254.169.254/latest/meta-data', 'not a public address'],
    ['https://localhost/x', 'not a public host name'],
    ['https://api.localhost/x', 'not a public host name'],
    ['https://redis/x', 'not a public host name'],
    ['https://db.internal/x', 'not a public host name'],
    ['https://printer.local./x', 'not a public host name'],
    ['not a url', 'not a URL'],
  ])('refuses %s', (url, reason) => {
    const r = checkUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });

  it('lets allowed hosts through on any address and over http', () => {
    expect(checkUrl('http://127.0.0.1:9000/x', { allowHosts: ['127.0.0.1'] }).ok).toBe(true);
    expect(checkUrl('http://localhost:9000/x', { allowHosts: ['localhost'] }).ok).toBe(true);
    expect(checkUrl('http://127.0.0.2:9000/x', { allowHosts: ['127.0.0.1'] }).ok).toBe(false);
  });

  it('allows plain http to public hosts only when the policy says so', () => {
    expect(checkUrl('http://example.com/x', { allowHttp: true }).ok).toBe(true);
    expect(checkUrl('http://127.0.0.1/x', { allowHttp: true }).ok).toBe(false);
  });
});

describe('safeRequest', () => {
  let server: Server;
  let port = 0;
  const got: { method?: string; body: string; headers: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        got.push({ method: req.method, body, headers: req.headers });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end();
        } else if (req.url === '/big') {
          res.writeHead(200).end('x'.repeat(5000));
        } else if (req.url === '/exact') {
          res.writeHead(200).end('y'.repeat(100));
        } else if (req.url === '/slow') {
          setTimeout(() => res.writeHead(200).end('late'), 500);
        } else {
          res.writeHead(201, { 'content-type': 'text/plain' }).end('created');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const allowed = { allowHosts: ['127.0.0.1'] };

  it('posts the body and returns the answer', async () => {
    const res = await safeRequest(
      `http://127.0.0.1:${port}/in`,
      { body: '{"a":1}', headers: { 'content-type': 'application/json' } },
      allowed,
    );
    expect(res).toMatchObject({ status: 201, body: 'created', truncated: false });
    expect(got.at(-1)).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(got.at(-1)?.headers['content-length']).toBe('7');
  });

  it('does not follow a redirect', async () => {
    const res = await safeRequest(`http://127.0.0.1:${port}/redirect`, {}, allowed);
    expect(res.status).toBe(302);
  });

  it('keeps at most maxResponseBytes of the answer', async () => {
    const big = await safeRequest(
      `http://127.0.0.1:${port}/big`,
      {},
      { ...allowed, maxResponseBytes: 100 },
    );
    expect(big.body).toHaveLength(100);
    expect(big.truncated).toBe(true);
    const exact = await safeRequest(
      `http://127.0.0.1:${port}/exact`,
      {},
      { ...allowed, maxResponseBytes: 100 },
    );
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.body).toHaveLength(100);
  });

  it('gives up at the timeout', async () => {
    await expect(
      safeRequest(`http://127.0.0.1:${port}/slow`, {}, { ...allowed, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(EgressTimeout);
  });

  it('refuses a URL the guard does not allow, before connecting', async () => {
    const before = got.length;
    const e = await safeRequest(`http://127.0.0.1:${port}/in`).catch((x) => x);
    expect(e).toBeInstanceOf(EgressBlocked);
    expect(isEgressBlocked(e)).toBe(true);
    expect(got.length).toBe(before);
  });

  it('refuses a public-looking name that resolves inside, at connect time', async () => {
    const inside: LookupAll = (_name, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const mixed: LookupAll = (_name, _o, cb) =>
      cb(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    for (const lookup of [inside, mixed]) {
      const e = await safeRequest(
        `http://hooks.example.com:${port}/in`,
        {},
        { allowHttp: true, lookup },
      ).catch((x) => x);
      expect(isEgressBlocked(e)).toBe(true);
      expect(String(e.message)).toContain('not public');
    }
  });

  it('passes on a resolver failure as it is', async () => {
    const missing: LookupAll = (_name, _o, cb) =>
      cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), []);
    const e = await safeRequest('https://hooks.example.com/in', {}, { lookup: missing }).catch(
      (x) => x,
    );
    expect(isEgressBlocked(e)).toBe(false);
    expect(e.code).toBe('ENOTFOUND');
  });
});
