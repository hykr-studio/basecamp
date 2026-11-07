// Declaring acceptances. Nothing here reads the configuration or loads Nest: an application module
// imports it at load time and contributes its acceptances (`contributes: { acceptances }`).
import { createHookRegistry, OtpChannel, type Principal } from '@hykr/contracts';
import type { Touched, Tx } from '@hykr/core';
import type { Labels } from '@hykr/i18n';
import type { DocumentRenderContext } from '../documents/define.js';

declare module '@hykr/contracts' {
  interface Contributions {
    acceptances: readonly AcceptanceDef[];
  }
}

type Values = Record<string, unknown>;

/** Who may accept: the record's customer, holders of a capability, or the application's check. */
export type AcceptanceSigner =
  | 'customer'
  | { capability: string }
  | ((p: Principal, row: Readonly<Values>) => boolean);

/** What `accepted` gets: the write's transaction, the signer, the stored row, the evidence. */
export interface AcceptedContext {
  tx: Tx;
  principal: Principal;
  /** The record as stored, after the acceptance's transition (when it has one). */
  row: Values;
  evidence: { id: string; documentId: string; sha256: string; recordVersion: number | null };
  /** Pass to repositories: entity rules see which operation writes. */
  via: { via: string };
}

/**
 * What can be accepted about one kind of record: one document's PDF, by whom, by which codes,
 * and what follows in the same transaction. The application declares it in the module whose
 * records it is about; the framework sends and checks the code, binds the acceptance to the PDF's
 * hash and the record's version, and keeps the evidence (docs/decisions/B8.md).
 */
// biome-ignore lint/suspicious/noExplicitAny: a document's data is its own
export interface AcceptanceDef<D = any> {
  /** Lower case and dotted, by its owner: 'orders.order'. Unique. */
  name: string;
  /** The document (`defineDocument`'s name) whose PDF is accepted. One acceptance per document. */
  document: string;
  /** What the accept button says: 'Accept the order'. */
  label: Labels;
  /**
   * The words the signer agrees to, from the document's stored data, in `ctx.lang`. Shown
   * before the code is asked for, and kept in the evidence.
   */
  statement(data: D, ctx: DocumentRenderContext): string;
  /** Who may accept. Anyone else is refused `not_signer`. */
  by: AcceptanceSigner;
  /** Where a code may go, in order. Default: WhatsApp, then email. `[]`: e-sign only. */
  channels?: readonly OtpChannel[];
  /** The record's transition when accepted, in the same transaction (its `expose: 'system'`). */
  transition?: string;
  /** A further check on the stored row: `{ rule, reason }` refuses. */
  when?(row: Readonly<Values>): { rule: string; reason: string } | null;
  /** An e-sign provider (`esignProviders`) it may be signed at instead of a code. */
  esign?: string;
  /** The code's life and attempts. Default: 10 minutes, 5 attempts. */
  otp?: { ttlMinutes?: number; attempts?: number };
  /** More work in the accepting transaction (a payment schedule): its touched rows and events. */
  accepted?(ctx: AcceptedContext): Promise<{ touched?: Touched[]; events?: object[] } | undefined>;
}

/** Lower case words joined by '.', '-' or '_': 'orders.order'. */
const NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

/** The channels an acceptance's code may go by. */
export const channelsOfAcceptance = (def: AcceptanceDef): OtpChannel[] => [
  ...(def.channels ?? (['whatsapp', 'email'] as const)),
];

/** An acceptance, checked: its name, document, signer, channels and methods. */
export function defineAcceptance<D>(def: AcceptanceDef<D>): AcceptanceDef<D> {
  const fail = (why: string) => {
    throw new Error(`Acceptance ${def.name}: ${why}`);
  };
  if (!NAME.test(def.name)) fail('name it <owner>.<kind> in lower case, like "orders.order"');
  if (!def.document) fail('name the document whose PDF is accepted');
  if (!def.by) fail('say who may accept it (by)');
  if (typeof def.by === 'object' && !def.by.capability) fail('name the capability in by');
  const channels = channelsOfAcceptance(def as AcceptanceDef);
  for (const c of channels) if (!OtpChannel.safeParse(c).success) fail(`"${c}" is not a channel`);
  if (new Set(channels).size !== channels.length) fail('a channel is listed twice');
  if (!channels.length && !def.esign) fail('give a channel for codes, or an e-sign provider');
  const { ttlMinutes, attempts } = def.otp ?? {};
  if (ttlMinutes !== undefined && !(Number.isInteger(ttlMinutes) && ttlMinutes >= 1))
    fail('otp.ttlMinutes is a whole number of minutes, at least 1');
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1 && attempts <= 10))
    fail('otp.attempts is between 1 and 10');
  return def;
}

/** Every acceptance the application declared, by name. Collects `contributes.acceptances`. */
export const acceptances = createHookRegistry<AcceptanceDef>(
  'acceptance',
  (d) => defineAcceptance(d).name,
  { collects: 'acceptances' },
);

/** The acceptance of a document kind, if it has one. */
export const acceptanceOf = (document: string): AcceptanceDef | undefined =>
  acceptances.all().find((a) => a.document === document);
