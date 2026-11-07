// A connector for the common case: a sender that signs the raw body with HMAC in one header
// (`X-Signature: sha256=<hex>`). An application builds one per sender it accepts.
import { createHash, randomBytes } from 'node:crypto';
import type { Labels } from '@hykr/i18n';
import { z } from 'zod';
import {
  type Connector,
  defineConnector,
  type InboundEvent,
  type InboundRequest,
  readHeader,
} from './connector.js';
import { type DigestEncoding, type HmacAlgorithm, verifyHmac } from './hmac.js';

const Credentials = z.object({ secret: z.string().min(16).max(500) });
export type HmacCredentials = z.infer<typeof Credentials>;

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
  /** The event's id. Default: a header named by `idHeader`, else a hash of the body. */
  eventId?(req: InboundRequest): string | undefined;
  /** A header with the sender's event id: 'x-event-id'. */
  idHeader?: string;
  /** The event's type. Default: the body's `type`, else 'event'. */
  eventType?(req: InboundRequest): string | undefined;
  /** Several events in one request: replaces eventId and eventType. */
  events?(req: InboundRequest): readonly InboundEvent[];
}

const typeOf = (body: unknown) => {
  const t = body && typeof body === 'object' ? (body as { type?: unknown }).type : undefined;
  return typeof t === 'string' && t ? t : 'event';
};

/** A connector whose sender signs the raw body with HMAC (SHA-256, hex, by default). */
export function hmacConnector(o: HmacConnectorOptions): Connector<HmacCredentials> {
  const header = o.header.toLowerCase();
  return defineConnector<HmacCredentials>({
    name: o.name,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
    credentials: Credentials,
    generate: () => ({ secret: randomBytes(32).toString('hex') }),
    inbound: {
      verify: (req, creds) =>
        verifyHmac({
          secret: creds.secret,
          payload: req.rawBody,
          signature: readHeader(req.headers, header),
          prefix: o.prefix,
          algorithm: o.algorithm,
          encoding: o.encoding,
        }),
      parse: (req) => {
        if (o.events) return o.events(req);
        const id =
          o.eventId?.(req) ??
          (o.idHeader ? readHeader(req.headers, o.idHeader) : undefined) ??
          createHash('sha256').update(req.rawBody).digest('hex');
        return [{ id, type: o.eventType?.(req) ?? typeOf(req.body), data: req.body ?? null }];
      },
    },
  });
}
