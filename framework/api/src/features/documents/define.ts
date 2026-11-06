// Declaring documents. Nothing here reads the configuration or loads Nest: an application module
// imports it at load time and contributes its documents (`contributes: { documents }`).
import {
  type AuthorizeResult,
  createHookRegistry,
  DocumentChannel,
  type DocumentRecipient,
  type Money,
  type Principal,
} from '@hykr/contracts';
import type { AnyEntityDef, ChildEntityDef, Tx } from '@hykr/core';
import type { Labels, Lang } from '@hykr/i18n';
import type { Reader, TemplateDef } from '@hykr/notifications';
import type { DocumentLayout } from './layout.js';

declare module '@hykr/contracts' {
  interface Contributions {
    documents: readonly DocumentDef[];
  }
}

type Values = Record<string, unknown>;

/** The business a document is made in. */
export interface DocumentBusiness {
  id: string;
  name: string;
  timeZone: string;
}

/**
 * What `load` gets: the record, read as the person who asks (the entity's scoped repository,
 * then projected for them, so a field they do not see is not here), and ways to read more the
 * same way. Everything `load` returns is stored with the document and is what it shows.
 */
export interface DocumentLoadContext {
  tx: Tx;
  principal: Principal;
  /** The record's id. */
  id: string;
  lang: Lang;
  /** The record in its read shape, projected for the principal. */
  record: Values;
  business: DocumentBusiness;
  /** Another record, read and projected the same way; null when the principal does not reach it. */
  read(def: AnyEntityDef, id: string): Promise<Values | null>;
  /** A child entity's rows under a parent (default: this record), in tree order, projected. */
  children(def: ChildEntityDef, parentId?: string): Promise<Values[]>;
}

/** What `render` gets besides the data: the language and formatting in it. */
export interface DocumentRenderContext {
  lang: Lang;
  business: DocumentBusiness;
  /** The phrase in the document's language. */
  label(labels: Labels): string;
  /** An amount, in the document's language (`moneyText`). */
  money(m: Money): string;
  /** A date in the business's time zone, in the document's language. Default: day, month, year. */
  date(value: string | Date, options?: Intl.DateTimeFormatOptions): string;
}

/** Who a send goes to (yourself resolved), and the document, for an application's own rule. */
export interface DocumentSendRequest {
  document: { id: string; name: string; resourceType: string; resourceId: string };
  to: Exclude<DocumentRecipient, { self: true }>;
}

/**
 * A kind of document about one kind of record: what it reads, how it is laid out, how it is
 * named and sent. The application declares it in the module whose records it is about; the
 * framework holds no template and no wording.
 */
// biome-ignore lint/suspicious/noExplicitAny: a document's data is its own
export interface DocumentDef<D = any> {
  /** Lower case and dotted, by its owner: 'orders.order'. Unique. */
  name: string;
  label: Labels;
  /** The entity (by name) whose records it is about. */
  entity: string;
  /**
   * The capabilities that change what it shows (a field hidden without them). A rendered copy is
   * reached by readers who hold each of these its requester held. `[]`: it shows nothing that is
   * hidden from anyone who reads the record. Default (undefined): every role and capability of
   * the requester counts, which is safe whatever the document shows.
   */
  capabilities?: readonly string[];
  /** What it shows, read as the principal, in the write's transaction. JSON only. */
  load(ctx: DocumentLoadContext): Promise<D> | D;
  /** Its pages, from the stored data. Pure: called when asked (to check it) and in the worker. */
  render(data: D, ctx: DocumentRenderContext): DocumentLayout;
  /** The file's name ('.pdf' is added when missing). */
  fileName(data: D, lang: Lang): string;
  /** How it goes out. Without it, it cannot be sent. */
  send?: {
    /** An approved template with a document header (`header: { type: 'document' }`). */
    whatsapp?: {
      // biome-ignore lint/suspicious/noExplicitAny: any template's parameters
      template: TemplateDef<any>;
      params(data: D, reader: Reader): Record<string, string>;
    };
    email?: { subject(data: D, reader: Reader): string; body(data: D, reader: Reader): string };
    /** Which first. Default: WhatsApp, then email (those it has). */
    order?: readonly DocumentChannel[];
  };
  /**
   * The application's say, replacing the default decision (null: the default). Rendering:
   * allowed to anyone who reaches the record. Sending: to yourself, allowed; to anyone else,
   * `customers.message` is needed and the assistant waits for approval.
   */
  authorize?: {
    render?(p: Principal, record: Values): AuthorizeResult | null;
    send?(p: Principal, request: DocumentSendRequest): AuthorizeResult | null;
  };
}

/** Lower case words joined by '.', '-' or '_': 'orders.order'. */
const NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

/** A document, checked: its name, its channels, its template's header. */
export function defineDocument<D>(def: DocumentDef<D>): DocumentDef<D> {
  const fail = (why: string) => {
    throw new Error(`Document ${def.name}: ${why}`);
  };
  if (!NAME.test(def.name)) fail('name it <owner>.<kind> in lower case, like "orders.order"');
  if (!def.entity) fail('name the entity it is about');
  const template = def.send?.whatsapp?.template;
  if (template && template.header?.type !== 'document')
    fail(`its template ${template.name} has no document header (header: { type: 'document' })`);
  for (const channel of def.send?.order ?? []) {
    if (!DocumentChannel.safeParse(channel).success) fail(`"${channel}" is not a channel`);
    if (!def.send?.[channel]) fail(`it is sent by ${channel} but says nothing for it`);
  }
  return def;
}

/** Every document the application declared, by name. Collects `contributes.documents`. */
export const documents = createHookRegistry<DocumentDef>(
  'document',
  (d) => defineDocument(d).name,
  { collects: 'documents' },
);

/** The channels a document goes by, in its order. */
export function channelsOf(def: DocumentDef): DocumentChannel[] {
  const order = def.send?.order ?? (['whatsapp', 'email'] as const);
  return order.filter((c) => !!def.send?.[c]);
}

/** A file name ending in .pdf, without path separators or control characters. */
export function pdfName(name: string): string {
  const clean =
    [...name]
      .map((c) =>
        c === '/' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '-' : c,
      )
      .join('')
      .trim()
      .slice(0, 200) || 'document';
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
}
