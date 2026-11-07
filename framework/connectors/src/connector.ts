// A connector: one kind of outside system a business connects to, as transport only. It says
// what credentials a connection needs (validated, then sealed by the server), which of them may
// be shown back, and how to verify and read what the system sends. What an event does in the
// application is a handler's work, on the server; the connector never touches the database.
import type { Labels } from '@hykr/i18n';
import type { z } from 'zod';

/** Request headers as Node gives them: lower-case names. */
export type InboundHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/** One inbound HTTP request, as a connector sees it. */
export interface InboundRequest {
  /** The exact bytes received: what a signature covers. */
  rawBody: Buffer;
  headers: InboundHeaders;
  /** The body as parsed (JSON or a form), for reading; never for verifying. */
  body: unknown;
  query: Readonly<Record<string, unknown>>;
}

/** One event a request carries. */
export interface InboundEvent {
  /** The sender's id for it: a redelivery has the same id and is stored once. At most 200. */
  id: string;
  /** What happened, in the sender's words: 'payment.captured'. At most 200. */
  type: string;
  data: unknown;
}

/** How a connector takes requests in. */
export interface ConnectorInbound<C> {
  /**
   * The sender posts no body: what `verify` checks is in the headers (a push channel's token).
   * Default false: a request without a body is refused before `verify`.
   */
  bodyless?: boolean;
  /** Is this request from the sender these credentials belong to? Constant-time checks only. */
  verify(req: InboundRequest, credentials: C, now?: number): boolean;
  /** The events in a verified request. Throw when it cannot be read: the sender gets a 400. */
  parse(req: InboundRequest, credentials: C): readonly InboundEvent[];
  /** A subscription check by GET: the text to answer with, or null to refuse it (403). */
  challenge?(req: InboundRequest, credentials: C): string | null;
}

/** One kind of outside system. Register it with the server's `connectors` contribution. */
export interface Connector<C = unknown> {
  /** Lower case: 'standard-webhooks'. Names the inbound URL, /webhooks/<name>/<connection>. */
  name: string;
  label: Labels;
  description?: Labels;
  /** What a connection stores, validated before it is sealed. */
  credentials: z.ZodType<C>;
  /** Fields that are not secret (an account id): stored in the clear and shown back. */
  publicFields?: readonly (keyof C & string)[];
  /** Make the credentials for a new connection (the secret the sender signs with). */
  generate?(): C;
  inbound?: ConnectorInbound<C>;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** A connector, checked: its name, and its public fields are plain field names. */
export function defineConnector<C>(def: Connector<C>): Connector<C> {
  if (!NAME.test(def.name))
    throw new Error(
      `Connector name "${def.name}" must be lower case letters, digits and "-" (at most 40)`,
    );
  for (const field of def.publicFields ?? [])
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
      throw new Error(`Connector ${def.name}: "${field}" is not a field name`);
  return def;
}

/** One header's value: the first when it was sent more than once. */
export function readHeader(headers: InboundHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

/** The ids and types the server stores: bounded, printable. */
export function checkEvent(e: InboundEvent): InboundEvent {
  const bounded = (s: unknown, what: string) => {
    const printable = typeof s === 'string' && [...s].every((c) => c.charCodeAt(0) >= 32);
    if (typeof s !== 'string' || !s.length || s.length > 200 || !printable)
      throw new Error(`The event's ${what} must be 1 to 200 printable characters`);
    return s;
  };
  return { id: bounded(e.id, 'id'), type: bounded(e.type, 'type'), data: e.data ?? null };
}
