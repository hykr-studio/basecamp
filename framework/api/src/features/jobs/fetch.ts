// Fetching a result file a service names by URL, without letting it point the server at its
// own network. Nothing here loads Nest.
import { lookup } from 'node:dns/promises';
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
 * only to public addresses. With `allowPrivate` (development), http and private hosts too.
 */
export async function checkResultUrl(raw: string, o: { allowPrivate: boolean }): Promise<URL> {
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
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true, verbatim: true }).then(
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
 * A result file's bytes from a URL: checked first, no redirects, at most `maxBytes`, given up
 * after `timeoutMs` or when `signal` aborts. A refusal (the URL, a redirect, the size) is a
 * `ResultRefused`; a network failure or a 5xx is an ordinary error, worth a retry.
 */
export async function fetchResult(
  raw: string,
  o: { allowPrivate: boolean; maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Buffer> {
  const url = await checkResultUrl(raw, o);
  const signals = [AbortSignal.timeout(o.timeoutMs), ...(o.signal ? [o.signal] : [])];
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.any(signals) });
  if (res.status >= 300 && res.status < 400)
    throw new ResultRefused('The result URL redirects: give the final URL');
  if (res.status >= 500) throw new Error(`The result URL answered ${res.status}`);
  if (!res.ok) throw new ResultRefused(`The result URL answered ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > o.maxBytes)
    throw new ResultRefused(`The result file is larger than ${o.maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body)
    // Leaving the loop early cancels the stream.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > o.maxBytes) break;
      chunks.push(Buffer.from(chunk));
    }
  if (size > o.maxBytes)
    throw new ResultRefused(`The result file is larger than ${o.maxBytes} bytes`);
  return Buffer.concat(chunks);
}
