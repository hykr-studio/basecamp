// Fetching a result file a service names by URL, without letting it point the server at its
// own network. Nothing here loads Nest.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/** A result file that can never be fetched or kept: retrying will not help. */
export class ResultRefused extends Error {}

// Two lists: a BlockList holding IPv4-mapped IPv6 rules would match every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
// IPv4: this network, private, carrier-grade NAT, loopback, link-local, benchmarking,
// documentation, multicast and reserved.
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked4.addSubnet(net, prefix, 'ipv4');
// IPv6: unspecified, loopback, IPv4-mapped and -translated (any IPv4 inside), unique local,
// link-local, multicast, documentation.
blocked6.addAddress('::', 'ipv6');
blocked6.addAddress('::1', 'ipv6');
for (const [net, prefix] of [
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked6.addSubnet(net, prefix, 'ipv6');

/** Is this address one the server must not fetch from (its own or a private network)? */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked4.check(address, 'ipv4');
  if (family === 6) return blocked6.check(address, 'ipv6');
  return true;
}

/**
 * Is this URL one the server may fetch a result from? https only, and a host that resolves
 * only to public addresses now. With `allowPrivate` (development), http and private hosts too.
 * A check ahead of time: `fetchResult` checks the addresses again as it connects.
 */
export async function checkResultUrl(raw: string, o: { allowPrivate: boolean }): Promise<URL> {
  const url = checkShape(raw, o);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (o.allowPrivate || isIP(host)) return url;
  const addresses = await lookup(host, { all: true, verbatim: true }).then(
    (found) => found.map((a) => a.address),
    () => {
      throw new Error(`The result host ${host} did not resolve`);
    },
  );
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new ResultRefused('The result URL points at a private address');
  return url;
}

/**
 * At connect time: every address the name has must be public, and the socket goes to one of
 * the addresses checked. Resolving once, here, leaves no gap between the check and the
 * connection for the name to change (DNS rebinding).
 */
function publicOnly(
  host: string,
  options: { all?: boolean; family?: number; hints?: number },
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(host, { all: true, family: options?.family, hints: options?.hints }, (err, list) => {
    if (err) return callback(new Error(`The result host ${host} did not resolve`), []);
    if (!list.length || list.some((a) => isPrivateAddress(a.address)))
      return callback(new ResultRefused('The result URL points at a private address'), []);
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** The URL's own rules, before any look-up: http(s), no credentials, no private address. */
function checkShape(raw: string, o: { allowPrivate: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResultRefused('The result URL is not a URL');
  }
  if (url.username || url.password) throw new ResultRefused('The result URL carries credentials');
  if (o.allowPrivate) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new ResultRefused('Result URLs must be http or https');
    return url;
  }
  if (url.protocol !== 'https:') throw new ResultRefused('Result URLs must be https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host))
    throw new ResultRefused('The result URL points at a private address');
  return url;
}

/**
 * A result file's bytes from a URL: checked first, no redirects, at most `maxBytes`, given up
 * after `timeoutMs` or when `signal` aborts. The name is resolved when the socket connects, and
 * only public addresses are connected to. A refusal (the URL, a redirect, the size) is a
 * `ResultRefused`; a network failure or a 5xx is an ordinary error, worth a retry.
 */
export async function fetchResult(
  raw: string,
  o: { allowPrivate: boolean; maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Buffer> {
  const url = checkShape(raw, o);
  const signal = AbortSignal.any([
    AbortSignal.timeout(o.timeoutMs),
    ...(o.signal ? [o.signal] : []),
  ]);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<Buffer>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'GET',
        signal,
        // A fresh agent per request: no pooled socket skips the address check.
        agent: false,
        ...(o.allowPrivate ? {} : { lookup: publicOnly as never }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const refuse = (e: Error) => {
          res.destroy();
          reject(e);
        };
        if (status >= 300 && status < 400)
          return refuse(new ResultRefused('The result URL redirects: give the final URL'));
        if (status >= 500) return refuse(new Error(`The result URL answered ${status}`));
        if (status < 200 || status >= 300)
          return refuse(new ResultRefused(`The result URL answered ${status}`));
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > o.maxBytes)
          return refuse(new ResultRefused(`The result file is larger than ${o.maxBytes} bytes`));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > o.maxBytes)
            return refuse(new ResultRefused(`The result file is larger than ${o.maxBytes} bytes`));
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    // The guard's refusal comes back as the request's error: keep it a refusal.
    req.on('error', (e) => reject(e instanceof ResultRefused ? e : unwrap(e)));
    req.end();
  });
}

/** A look-up's refusal arrives wrapped by the socket on some Node versions. */
const unwrap = (e: Error): Error => {
  const cause = (e as { cause?: unknown }).cause;
  return cause instanceof ResultRefused ? cause : e;
};
