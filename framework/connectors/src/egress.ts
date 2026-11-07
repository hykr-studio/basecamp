// The egress guard: what a server may call when the address comes from a business (a webhook
// URL, a connector's endpoint). Internal services (the database, Redis, object storage, cloud
// metadata) live on loopback, private and link-local addresses, so only public addresses are
// reached. The address is checked twice: when the URL is saved (`checkUrl`) and when the socket
// connects (`safeRequest`'s DNS lookup), so a name that later resolves inside cannot be reached.
import dns, { type LookupAddress } from 'node:dns';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/** A request the guard refused: the address is not public, or the URL is not allowed. */
export class EgressBlocked extends Error {
  override readonly name = 'EgressBlocked';
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The request took longer than its policy allows. */
export class EgressTimeout extends Error {
  override readonly name = 'EgressTimeout';
}

export const isEgressBlocked = (e: unknown): e is EgressBlocked =>
  e instanceof EgressBlocked || (e instanceof Error && e.name === 'EgressBlocked');

/** `dns.lookup` with `{ all: true }`: every address a name has. Injected by tests. */
export type LookupAll = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface EgressPolicy {
  /**
   * Host names (lower case, no port) let through on any address and over plain http: a
   * development receiver on localhost. Empty by default.
   */
  allowHosts?: readonly string[];
  /** Plain http to public addresses. Default: https only. */
  allowHttp?: boolean;
  /** The whole request, connect to last byte. Default 10 s. */
  timeoutMs?: number;
  /** Bytes of the answer kept; the rest is dropped. Default 64 KB. */
  maxResponseBytes?: number;
  /** DNS, for tests. Default: the system resolver. */
  lookup?: LookupAll;
}

/* ── Addresses ─────────────────────────────────────────────────────────────── */

function v4Bytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function v6Bytes(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  if (ip.slice(lastColon + 1).includes('.')) {
    const v4 = v4Bytes(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail.push(...v4);
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s ? s.split(':') : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function inPrefix(bytes: readonly number[], net: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if ((bytes[byte] & mask) !== ((net[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** IPv4 ranges that are not the public internet (RFC 6890 and its successors). */
const V4_NOT_PUBLIC: readonly [string, number][] = [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared (carrier NAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];
const V4_RANGES = V4_NOT_PUBLIC.map(([net, bits]) => [v4Bytes(net) as number[], bits] as const);

const hex = (s: string) => v6Bytes(s) as number[];
/** Global unicast is 2000::/3; these parts of it are not public. */
const V6_NOT_PUBLIC = [
  [hex('2001::'), 23], // protocol assignments (Teredo, benchmarking, ORCHID)
  [hex('2001:db8::'), 32], // documentation
  [hex('3fff::'), 20], // documentation
] as const;
const V6_GLOBAL = [hex('2000::'), 3] as const;

function publicV4(bytes: readonly number[]): boolean {
  return !V4_RANGES.some(([net, bits]) => inPrefix(bytes, net, bits));
}

/** The IPv4 address an IPv6 one carries (mapped, NAT64, 6to4), if any. */
function embeddedV4(b: readonly number[]): number[] | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16); // ::ffff:a.b.c.d
  if (inPrefix(b, hex('64:ff9b::'), 96)) return b.slice(12, 16); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6); // 6to4
  return null;
}

/**
 * Is this IP address on the public internet? False for loopback, private, shared, link-local,
 * documentation, benchmarking, multicast and reserved ranges, in IPv4 and IPv6, and for an IPv6
 * address that carries a non-public IPv4 one. False for anything that is not an IP address.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0]);
  if (kind === 4) {
    const b = v4Bytes(ip);
    return b !== null && publicV4(b);
  }
  if (kind === 6) {
    const b = v6Bytes(ip);
    if (!b) return false;
    const v4 = embeddedV4(b);
    if (v4) return publicV4(v4);
    if (!inPrefix(b, V6_GLOBAL[0], V6_GLOBAL[1])) return false;
    return !V6_NOT_PUBLIC.some(([net, bits]) => inPrefix(b, net, bits));
  }
  return false;
}

/* ── URLs ──────────────────────────────────────────────────────────────────── */

/** Names that only mean something inside a network. */
const INTERNAL_NAME = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home\.arpa)$/;

const hostOf = (url: URL) =>
  url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

const allowedHost = (host: string, policy: EgressPolicy) =>
  (policy.allowHosts ?? []).some((h) => h.toLowerCase().replace(/\.$/, '') === host);

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * May a server call this URL? `http`/`https` only (https unless allowed), no user name or
 * password in it, and a host that is a public IP address or a dotted name that does not mean
 * something only inside a network. A name's addresses are checked when it is called.
 */
export function checkUrl(raw: string, policy: EgressPolicy = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, reason: 'only http and https URLs can be called' };
  if (url.username || url.password)
    return { ok: false, reason: 'a URL may not carry a user name or password' };
  const host = hostOf(url);
  if (!host) return { ok: false, reason: 'the URL has no host' };
  if (allowedHost(host, policy)) return { ok: true, url };
  // Where it points first: that is the reason that matters.
  if (isIP(host)) {
    if (!isPublicAddress(host)) return { ok: false, reason: `${host} is not a public address` };
  } else if (!host.includes('.') || INTERNAL_NAME.test(host))
    return { ok: false, reason: `${host} is not a public host name` };
  if (url.protocol === 'http:' && !policy.allowHttp)
    return { ok: false, reason: 'only https URLs can be called' };
  return { ok: true, url };
}

/* ── Requests ──────────────────────────────────────────────────────────────── */

/** Resolve every address of a name, and refuse it when any one of them is not public. */
function guardedLookup(resolve: LookupAll, anyAddress: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number; hints?: number },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    resolve(
      hostname,
      { family: options?.family, hints: options?.hints, all: true },
      (err, list) => {
        if (err) return callback(err, []);
        if (!list?.length)
          return callback(
            Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }),
            [],
          );
        if (!anyAddress) {
          const inside = list.find((a) => !isPublicAddress(a.address));
          if (inside)
            return callback(
              new EgressBlocked(`${hostname} resolves to ${inside.address}, which is not public`),
              [],
            );
        }
        if (options?.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      },
    );
  };
}

export interface EgressResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** The answer as text, at most `maxResponseBytes` of it. */
  body: string;
  /** The answer was longer than what was kept. */
  truncated: boolean;
  durationMs: number;
}

/**
 * One HTTP request under the egress guard: the URL is checked, the connection goes only to the
 * public addresses the name resolves to, redirects are not followed (a 3xx is returned as it
 * is), and the request ends at `timeoutMs`. Rejects with `EgressBlocked` when the guard refuses,
 * `EgressTimeout` when it takes too long, and the network's error otherwise.
 */
export function safeRequest(
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
  policy: EgressPolicy = {},
): Promise<EgressResponse> {
  const checked = checkUrl(rawUrl, policy);
  if (!checked.ok) return Promise.reject(new EgressBlocked(checked.reason));
  const url = checked.url;
  const anyAddress = allowedHost(hostOf(url), policy);
  const lookup = guardedLookup(policy.lookup ?? (dns.lookup as unknown as LookupAll), anyAddress);
  const max = policy.maxResponseBytes ?? 64 * 1024;
  const timeoutMs = policy.timeoutMs ?? 10_000;
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length'))
    headers['content-length'] = String(body.length);
  const transport = url.protocol === 'https:' ? https : http;
  const started = Date.now();

  return new Promise<EgressResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: EgressResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as EgressResponse);
    };
    const req = transport.request(
      url,
      // A fresh agent per request: no pooled socket skips the address check.
      { method: init.method ?? 'POST', headers, lookup: lookup as never, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let kept = 0;
        let truncated = false;
        const done = () =>
          finish(null, {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            durationMs: Date.now() - started,
          });
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = max - kept;
          if (chunk.length <= room) {
            chunks.push(chunk);
            kept += chunk.length;
            return;
          }
          // More than the policy keeps: keep what fits and stop reading.
          chunks.push(chunk.subarray(0, room));
          kept = max;
          truncated = true;
          res.destroy();
          done();
        });
        res.on('end', done);
        // Closed before the end, without an error of its own: the answer was cut off.
        res.on('close', () =>
          res.complete || truncated
            ? done()
            : finish(new Error('The connection closed before the answer ended')),
        );
        res.on('error', (e) => (truncated ? done() : finish(e)));
      },
    );
    const timer = setTimeout(
      () => req.destroy(new EgressTimeout(`No answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    req.on('error', (e) => finish(e));
    req.end(body);
  });
}
