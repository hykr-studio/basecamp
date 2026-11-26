// A connector: one kind of outside system a business connects to, as transport only. It says
// what credentials a connection needs (validated, then sealed by the server), which of them may
// be shown back, and how to verify and read what the system sends. What an event does in the
// application is a handler's work, on the server; the connector never touches the database.
import { createHash } from 'node:crypto';
import type { Labels } from '@hykr/i18n';
import type { z } from 'zod';
import { type ConnectorCall, type ConnectorOAuth, oauthProblems } from './oauth.js';

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
  /**
   * The sender's id for it: a redelivery has the same id. The server stores the event once
   * under it only when the connector's `signedIds` says it is signed. At most 200.
   */
  id: string;
  /** What happened, in the sender's words: 'payment.captured'. At most 200. */
  type: string;
  data: unknown;
}

/** The deployment's app at a provider, for a shared URL: its client and its other settings. */
export interface SharedApp {
  clientId: string;
  clientSecret: string;
  /** `<clientFrom>_<name>` from the environment (`setting('VERIFY_TOKEN')`). */
  setting(name: string): string | undefined;
}

/**
 * One URL for the whole provider, `/webhooks/<connector>` (decisions B24): the provider signs
 * every request with the app's secret, and each event names the account it is about. Only an
 * account a sign-in found (`oauth.describe`, from the provider's own answer) receives events, so
 * no business can claim another's.
 */
export interface SharedInbound {
  /** Is this request from the provider? Constant-time checks only. */
  verify(req: InboundRequest, app: SharedApp, now?: number): boolean;
  /** The events in a verified request. Throw when it cannot be read: the sender gets a 400. */
  parse(req: InboundRequest, app: SharedApp): readonly InboundEvent[];
  /** A subscription check by GET: the text to answer with, or null to refuse it (403). */
  challenge?(req: InboundRequest, app: SharedApp): string | null;
  /** The account an event is about: the id a connection holds (a page id). */
  accountOf(event: InboundEvent): string;
}

/** What `expand` works with: the account the event came for and calls on the connection's behalf. */
export interface ExpandContext {
  /** The account the event was routed by (a shared URL), else null. */
  account: string | null;
  call: ConnectorCall;
}

/** How a connector takes requests in. */
export interface ConnectorInbound<C> {
  /**
   * The sender posts no body: what `verify` checks is in the headers (a push channel's token).
   * Default false: a request without a body is refused before `verify`.
   */
  bodyless?: boolean;
  /**
   * The ids `parse` returns are covered by what `verify` checks: changing one breaks the
   * request's proof (the id is in the signed content, or read from the signed body). Default
   * false: the server then stores each event under `bodyKey(rawBody)` instead, so a captured
   * request posted again under a fresh id is still one event. A `bodyless` sender has no body
   * to key by and must set it.
   */
  signedIds?: boolean;
  /**
   * Is this request from the sender these credentials belong to? Constant-time checks only.
   * With `verify` and `parse` the connector takes requests at /webhooks/<name>/<connection>.
   */
  verify?(req: InboundRequest, credentials: C, now?: number): boolean;
  /** The events in a verified request. Throw when it cannot be read: the sender gets a 400. */
  parse?(req: InboundRequest, credentials: C): readonly InboundEvent[];
  /** A subscription check by GET: the text to answer with, or null to refuse it (403). */
  challenge?(req: InboundRequest, credentials: C): string | null;
  /**
   * A subscription check by POST (Microsoft Graph's `?validationToken=`): the text to answer
   * with, as text/plain, or null when the request is not one (it is then verified as usual).
   * Nothing is stored for it. Such a check carries no proof, so the answer must only echo what
   * the sender sent.
   */
  handshake?(req: InboundRequest, credentials: C): string | null;
  /** One URL for the provider, routed by account: needs `oauth`. */
  shared?: SharedInbound;
  /**
   * The event in full, fetched once in the worker before any handler runs (a notice that names a
   * record, turned into the record): its type and data replace the stored ones. A retry or a
   * redelivery does not fetch it again. An error retries the event.
   */
  expand?(event: InboundEvent, ctx: ExpandContext): Promise<InboundEvent>;
}

/** One kind of outside system. Register it with the server's `connectors` contribution. */
export interface Connector<C = unknown> {
  /** Lower case: 'standard-webhooks'. Names the inbound URL, /webhooks/<name>/<connection>. */
  name: string;
  label: Labels;
  description?: Labels;
  /**
   * What a connection stores, validated before it is sealed. A connector with `oauth` stores its
   * grant's tokens: `oauthCredentials`.
   */
  credentials: z.ZodType<C>;
  /** Fields that are not secret (an account id): stored in the clear and shown back. */
  publicFields?: readonly (keyof C & string)[];
  /** Make the credentials for a new connection (the secret the sender signs with). */
  generate?(): C;
  inbound?: ConnectorInbound<C>;
  /** Connected by signing in, never by pasting credentials (decisions B24). */
  oauth?: ConnectorOAuth;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * A connector, checked: its name, its public fields are plain field names, a sender that posts
 * no body says its ids are signed (there is nothing else to key its events by), a shared URL is
 * only for a connector that signs in, and an OAuth connector's URLs are https on its listed hosts.
 */
export function defineConnector<C>(def: Connector<C>): Connector<C> {
  if (!NAME.test(def.name))
    throw new Error(
      `Connector name "${def.name}" must be lower case letters, digits and "-" (at most 40)`,
    );
  for (const field of def.publicFields ?? [])
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
      throw new Error(`Connector ${def.name}: "${field}" is not a field name`);
  if (def.inbound?.bodyless && !def.inbound.signedIds)
    throw new Error(
      `Connector ${def.name}: a sender that posts no body has only its ids to key events by: set inbound.signedIds once verify covers them`,
    );
  const inbound = def.inbound;
  if (inbound && !!inbound.verify !== !!inbound.parse)
    throw new Error(`Connector ${def.name}: inbound.verify and inbound.parse go together`);
  if (inbound && !inbound.verify && !inbound.shared)
    throw new Error(`Connector ${def.name}: inbound needs verify and parse, or shared`);
  if (inbound?.shared && !def.oauth)
    throw new Error(
      `Connector ${def.name}: a shared URL routes by account ids only a sign-in may write: declare oauth`,
    );
  if (def.oauth) {
    const problems = oauthProblems(def.name, def.oauth);
    if (problems.length) throw new Error(problems.join('; '));
  }
  return def;
}

/**
 * The key of an event whose id is not signed: a hash of the exact bytes received (what the
 * signature covers), and its place when the request carries several. `sha256:<hex>[:<n>]`.
 */
export function bodyKey(rawBody: Buffer | string, index?: number): string {
  const hash = createHash('sha256').update(rawBody).digest('hex');
  return index === undefined ? `sha256:${hash}` : `sha256:${hash}:${index}`;
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
