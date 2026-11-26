// A connector for the common case: a sender that signs each request with HMAC in one header
// (`X-Signature: sha256=<hex>`). By default the signature covers the raw body alone; a sender
// that also signs its event id or the time it sent the request says how (`signedContent`).
// An application builds one per sender it accepts.
import { randomBytes } from 'node:crypto';
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import {
  bodyKey,
  type Connector,
  defineConnector,
  type InboundEvent,
  type InboundRequest,
  readHeader,
} from './connector.js';
import { type DigestEncoding, type HmacAlgorithm, verifyHmac } from './hmac.js';
import { DEFAULT_TOLERANCE_SEC } from './signature.js';

const Credentials = z.object({ secret: z.string().min(16).max(500) });
export type HmacCredentials = z.infer<typeof Credentials>;

/** The header values a sender may sign besides its body, as received. */
export interface HmacSignedParts {
  /** The `idHeader`'s value. */
  id?: string;
  /** The `timestampHeader`'s value. */
  timestamp?: string;
}

export interface HmacConnectorOptions {
  name: string;
  label: Labels;
  description?: Labels;
  /** The header that carries the signature: 'x-signature'. */
  header: string;
  /** Text before the digest: 'sha256='. Default none. */
  prefix?: string;
  algorithm?: HmacAlgorithm;
  encoding?: DigestEncoding;
  /**
   * The bytes the sender signs, built exactly as it builds them. Default: the raw body alone. A
   * sender that signs its id and a timestamp too:
   * `(req, { id, timestamp }) => `${timestamp}.${id}.${req.rawBody}``.
   */
  signedContent?(req: InboundRequest, parts: HmacSignedParts): string | Buffer;
  /** The event's id. Default: a header named by `idHeader`, else `bodyKey` of the body. */
  eventId?(req: InboundRequest): string | undefined;
  /** A header with the sender's event id: 'x-event-id'. */
  idHeader?: string;
  /**
   * A header with the time the sender signed the request: 'x-timestamp'. A request without it,
   * or further than `toleranceSec` from now either way, is refused. `signedContent` must cover it.
   */
  timestampHeader?: string;
  /** The timestamp's unit since the epoch. Default seconds. */
  timestampUnit?: 's' | 'ms';
  /** How far the timestamp may be from now, either way, in seconds. Default 300. */
  toleranceSec?: number;
  /**
   * The ids are signed: `signedContent` covers the `idHeader`, or `eventId` / `events` read them
   * from the signed body. With an `idHeader`, a request without it is then refused. Default: true
   * only when the id is the hash of the body. Otherwise the server stores each event under the
   * body's hash instead (`ConnectorInbound.signedIds`).
   */
  signedIds?: boolean;
  /** The event's type. Default: the body's `type`, else 'event'. */
  eventType?(req: InboundRequest): string | undefined;
  /** Several events in one request: replaces eventId and eventType. */
  events?(req: InboundRequest): readonly InboundEvent[];
}

const typeOf = (body: unknown) => {
  const t = body && typeof body === 'object' ? (body as { type?: unknown }).type : undefined;
  return typeof t === 'string' && t ? t : 'event';
};

/** Options that cannot work, refused when the connector is made. */
function check(o: HmacConnectorOptions) {
  const fail = (why: string) => {
    throw new Error(`hmacConnector ${o.name}: ${why}`);
  };
  if (o.timestampHeader && !o.signedContent)
    fail('a timestamp the signature does not cover proves nothing: give signedContent');
  const idFromHeader = !!o.idHeader && !o.eventId && !o.events;
  if (o.signedIds && idFromHeader && !o.signedContent)
    fail('a signature over the body alone does not cover the id header: give signedContent');
  const t = o.toleranceSec;
  if (t !== undefined && (!Number.isInteger(t) || t <= 0))
    fail('toleranceSec must be a positive whole number of seconds');
}

/** A connector whose sender signs each request with HMAC (SHA-256, hex, by default). */
export function hmacConnector(o: HmacConnectorOptions): Connector<HmacCredentials> {
  check(o);
  const header = o.header.toLowerCase();
  const idFromHeader = !!o.idHeader && !o.eventId && !o.events;
  // Without an id of the sender's, the id is the hash of the signed body.
  const signedIds = o.signedIds ?? (!o.idHeader && !o.eventId && !o.events);
  const tolerance = o.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const perSecond = o.timestampUnit === 'ms' ? 1000 : 1;

  const fresh = (stamp: string | undefined, now: number) => {
    if (!stamp || !/^\d{1,15}$/.test(stamp)) return false;
    const at = Math.floor(Number(stamp) / perSecond);
    return Math.abs(Math.floor(now / 1000) - at) <= tolerance;
  };

  return defineConnector<HmacCredentials>({
    name: o.name,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
    credentials: Credentials,
    generate: () => ({ secret: randomBytes(32).toString('hex') }),
    inbound: {
      signedIds,
      verify: (req, creds, now) => {
        const id = o.idHeader ? readHeader(req.headers, o.idHeader) : undefined;
        const timestamp = o.timestampHeader
          ? readHeader(req.headers, o.timestampHeader)
          : undefined;
        if (o.timestampHeader && !fresh(timestamp, now ?? Date.now())) return false;
        // A signed id must be there: without it the event would be named by its body.
        if (signedIds && idFromHeader && !id) return false;
        let payload: string | Buffer;
        try {
          payload = o.signedContent ? o.signedContent(req, { id, timestamp }) : req.rawBody;
        } catch {
          return false;
        }
        return verifyHmac({
          secret: creds.secret,
          payload,
          signature: readHeader(req.headers, header),
          prefix: o.prefix,
          algorithm: o.algorithm,
          encoding: o.encoding,
        });
      },
      parse: (req) => {
        if (o.events) return o.events(req);
        const id =
          o.eventId?.(req) ??
          (o.idHeader ? readHeader(req.headers, o.idHeader) : undefined) ??
          bodyKey(req.rawBody);
        return [{ id, type: o.eventType?.(req) ?? typeOf(req.body), data: req.body ?? null }];
      },
    },
  });
}
