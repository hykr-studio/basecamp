// A job's result URL (B11) is fetched only from the addresses it was checked against (V6): a
// name that answers with a public address when looked up and with a private one when the socket
// connects (DNS rebinding) reaches nothing inside.

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The look-up before the fetch sees a public address; the connection itself resolves the name
// again, to this machine. Both resolvers are controlled: no real DNS answers for the name.
const NAME = 'result.example';
const connectLookups: string[] = [];
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = (
    host: string,
    options: unknown,
    callback: (err: Error | null, address: unknown, family?: number) => void,
  ) => {
    if (host !== NAME) return actual.lookup(host, options as never, callback as never);
    connectLookups.push(host);
    const list = [{ address: '127.0.0.1', family: 4 }];
    if ((options as { all?: boolean } | undefined)?.all) callback(null, list);
    else callback(null, '127.0.0.1', 4);
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const { checkResultUrl, fetchResult, ResultRefused } = await import(
  '../../dist/features/jobs/fetch.js'
);

let inside: Server;
let port = 0;
let connections = 0;

beforeAll(async () => {
  inside = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((r) => inside.listen(0, '127.0.0.1', r));
  port = (inside.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => inside.close(() => r())));

describe('a result URL', () => {
  it('whose name resolves inside when connecting is refused, and nothing inside is reached', async () => {
    // Checked ahead of time, the name looks public.
    await expect(
      checkResultUrl(`https://${NAME}:${port}/result.png`, { allowPrivate: false }),
    ).resolves.toBeInstanceOf(URL);
    const e = await fetchResult(`https://${NAME}:${port}/result.png`, {
      allowPrivate: false,
      maxBytes: 1024,
      timeoutMs: 3000,
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ResultRefused);
    // Refused by the look-up the socket itself made, before any connection.
    expect(connectLookups).toContain(NAME);
    expect(connections).toBe(0);
  });
});
