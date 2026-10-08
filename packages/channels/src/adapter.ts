/**
 * The only shapes the rest of the system sees of a messaging channel. Everything WhatsApp
 * specific (its webhook envelope, Graph payloads, error codes) stays inside an adapter; a later
 * SMS, Telegram or email adapter implements the same interface.
 */

/** A message from a person, normalized. */
export type InboundMessage = {
  providerMessageId: string;
  /** The business number it was sent to (picks the business). */
  to: string;
  /** The sender, E.164 digits without the plus (WhatsApp's wa_id). */
  from: string;
  profileName?: string;
  at: Date;
  body:
    | { kind: 'text'; text: string }
    /** A reply button or a template's quick-reply button: our own payload comes back. */
    | { kind: 'button'; payload: string; text?: string }
    | { kind: 'list'; rowId: string; title?: string }
    | { kind: 'audio'; mediaId: string; mime: string }
    | { kind: 'media'; mediaId: string; mime: string; caption?: string };
  /** The message being answered, if any. */
  replyTo?: string;
};

/** What became of a message we sent. */
export type StatusUpdate = {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode?: number;
  at: Date;
};

/** A message to send, normalized. Buttons: at most 3; list rows: at most 10. */
export type OutboundMessage =
  | { kind: 'text'; to: string; text: string }
  | { kind: 'buttons'; to: string; text: string; buttons: { id: string; title: string }[] }
  | {
      kind: 'list';
      to: string;
      text: string;
      button: string;
      rows: { id: string; title: string; description?: string }[];
    }
  | {
      kind: 'template';
      to: string;
      name: string;
      language: string;
      /** Named parameters for the body. */
      params: Record<string, string>;
      /** One payload per quick-reply button, in order; URL buttons take their parameter. */
      buttons?: ({ payload: string } | { urlParam: string })[];
    };

/** A template as the provider holds it. */
export type RemoteTemplate = {
  id: string;
  name: string;
  language: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED' | string;
  category: string;
  rejectedReason?: string;
};

/** A template to create, in the provider's terms (built from defineTemplate). */
export type TemplateSpec = {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  body: string;
  /** Example values for the body's named parameters (the provider's review needs them). */
  examples: Record<string, string>;
  footer?: string;
  buttons?: (
    | { type: 'QUICK_REPLY'; text: string }
    | { type: 'URL'; text: string; url: string; example?: string }
  )[];
};

/** A failure worth trying again (rate limits, the provider's own errors). */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    /** How long the provider asked us to wait, if it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A failure that will fail again: a number not on WhatsApp, a template not approved, … */
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface ChannelAdapter {
  readonly channel: 'whatsapp';
  readonly capabilities: {
    maxButtons: number;
    maxListRows: number;
    maxTextLength: number;
    templates: boolean;
    media: boolean;
  };
  /** Is this webhook really from the provider (a signature over the exact bytes)? */
  verify(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** The messages and statuses in a webhook. Anything unknown is skipped, never fatal. */
  parse(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[]; skipped: string[] };
  send(from: string, msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  /** Blue ticks: the person sees we have read their message while the agent works. */
  markRead(from: string, providerMessageId: string): Promise<void>;
  /** A received file, by its id; the number it was sent to scopes the lookup. */
  downloadMedia(mediaId: string, phoneNumberId?: string): Promise<{ bytes: Buffer; mime: string }>;
  templates: {
    list(): Promise<RemoteTemplate[]>;
    create(t: TemplateSpec): Promise<{ id: string }>;
  };
}
