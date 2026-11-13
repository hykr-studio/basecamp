import type { Labels, Lang } from '@hykr/i18n';
import type { TemplateDef } from './define-template.js';

/**
 * Who a notification is for: a person with an account, a customer, a contact, every member of
 * the business whose roles hold a capability (`except` these people: the one who asked), every
 * person of a party (`partyId`), or every person of every party on a record (`participantsOf`,
 * only in the participant roles `as` names, if any).
 */
export type Recipient =
  | { userId: string }
  | { customerId: string }
  | { contactId: string }
  | { capability: string; except?: string[] }
  | { partyId: string }
  | { participantsOf: { type: string; id: string }; as?: string[] };

/**
 * How a recipient reads: their language and time zone, and where the app is (the deployment's
 * APP_URL, set by the dispatcher) for a link in an email or a message.
 */
export type Reader = { lang: Lang; timeZone: string; appUrl?: string };

/** A business record as notifications see it: its columns, dates as ISO strings. */
export type Row = Record<string, unknown> & { id: string; tenantId: string };

/**
 * The channels a notification can name. WhatsApp and email are built in to the dispatcher; push
 * and the in-app inbox (`inapp`) are the framework's push and inbox features (@hykr/api,
 * registered delivery channels). Another feature
 * that registers a delivery channel (@hykr/api's `deliveryChannels`) adds its name here, and any
 * content of its own on `NotificationDef`, by declaration merging:
 *
 *   declare module '@hykr/notifications' {
 *     interface NotificationChannels { pager: true }
 *     interface NotificationDef<R extends Row = Row> { pager?: { text: (row: R) => string } }
 *   }
 */
export interface NotificationChannels {
  whatsapp: true;
  email: true;
  push: true;
  inapp: true;
}
export type NotificationChannel = keyof NotificationChannels & string;

/**
 * Something that should reach a person, and when. Feature code says what; notify() decides
 * how: which channel, which template in which language, whether consent and quiet hours allow
 * it, and what to do when a channel can't deliver. No feature code sends a message itself.
 *
 * Two kinds of functions see the record. Who receives it (`to`, `when`, `dedupe`, `approval`,
 * `schedule.at`, `channelWhen`) reads it as stored. What it says (`whatsapp.params`, `email`,
 * `push`, `inapp`) reads it as each recipient may: the record's read schema, without the fields
 * its field policy and read projectors hide from them, plus the event's own data (decisions H1).
 */
export interface NotificationDef<R extends Row = Row> {
  /** meeting.reminder */
  key: string;
  /** The consent it needs (reminders: on until STOP; marketing: only with an explicit yes). */
  topic: 'service' | 'reminders' | 'marketing';
  /**
   * Fire later instead of now: on these events (`<entity>.<created|updated|deleted>` or a
   * command's), at this time (null: not scheduled, and any scheduled one is cancelled).
   */
  schedule?: {
    on: string[];
    at: (row: R) => Date | null;
    cancelOn?: string[];
  };
  /** Send now on these events (a notification is scheduled, sent on an event, or by notify()). */
  send?: { on: string[] };
  /** Only when this holds for the row. */
  when?: (row: R) => boolean;
  to: (row: R) => Recipient[];
  /** In order: the next one when one can't be used or fails for good. */
  channels: readonly NotificationChannel[];
  /**
   * Channels it goes to as well, whatever `channels` does (the in-app inbox keeps every approval
   * request, however it reached the person). Not tried again by a fallback.
   */
  also?: readonly NotificationChannel[];
  /**
   * A channel used only when this holds for the stored row; otherwise the next one is tried (an
   * approval request goes to WhatsApp only when it may be decided there). A channel the
   * notification does not list (an override took it out) is ignored.
   */
  channelWhen?: Partial<Record<NotificationChannel, (row: R) => boolean>>;
  /** The template it goes as on WhatsApp. Required when WhatsApp is one of its channels. */
  whatsapp?: {
    // biome-ignore lint/suspicious/noExplicitAny: any template's parameters
    template: TemplateDef<any>;
    params: (row: R, reader: Reader) => Record<string, string>;
  };
  email?: {
    subject: (row: R, reader: Reader) => string;
    body: (row: R, reader: Reader) => string;
  };
  /**
   * What a push notification to the person's phone says. Required when `'push'` is a channel.
   * Push text shows on a lock screen: keep it to what the recipient may read anywhere.
   */
  push?: {
    title: (row: R, reader: Reader) => string;
    body: (row: R, reader: Reader) => string;
    /** The app path a tap opens ('/orders/<id>'). Without it, a tap opens the app. */
    url?: (row: R) => string;
  };
  /**
   * What the person's in-app inbox keeps. Required when `'inapp'` is a channel. It reaches
   * people with an account only: for a contact without one, the next channel is tried.
   */
  inapp?: {
    title: (row: R, reader: Reader) => string;
    body: (row: R, reader: Reader) => string;
    /** The app path a tap opens ('/orders/<id>'). */
    url?: (row: R) => string;
    /** The record it is about: the app opens it with its link for that type, when no `url`. */
    record?: (row: R) => { type: string; id: string };
  };
  /**
   * A quick-reply button tapped on the template, by button id: schedule it again, and what to
   * say back.
   */
  onButton?: Record<string, (row: R) => { reschedule?: Date; reply?: Labels } | undefined>;
  /**
   * The approval its quick replies decide: buttons `approve` and `reject` become signed
   * payloads, bound to the contact they are sent to and valid for 30 minutes.
   */
  approval?: (row: R) => string;
  /** One per thing: a reschedule replaces the scheduled one with the same key. */
  dedupe: (row: R) => string;
}

/** Every channel a notification goes by: its chain, then the ones it always goes to as well. */
export const channelsOf = (
  def: Pick<NotificationDef, 'channels' | 'also'>,
): NotificationChannel[] => [...def.channels, ...(def.also ?? [])];

export function defineNotification<R extends Row>(def: NotificationDef<R>): NotificationDef<R> {
  if (!def.channels.length) throw new Error(`Notification ${def.key}: name at least one channel`);
  const all = channelsOf(def);
  if (new Set(all).size !== all.length)
    throw new Error(`Notification ${def.key}: a channel is named twice`);
  if (all.includes('whatsapp') && !def.whatsapp)
    throw new Error(`Notification ${def.key}: WhatsApp is a channel but has no template`);
  if (all.includes('email') && !def.email)
    throw new Error(`Notification ${def.key}: email is a channel but has no subject and body`);
  if (all.includes('push') && !def.push)
    throw new Error(`Notification ${def.key}: push is a channel but has no title and body`);
  if (all.includes('inapp') && !def.inapp)
    throw new Error(`Notification ${def.key}: inapp is a channel but has no title and body`);
  if ((def.onButton || def.approval) && !def.whatsapp)
    throw new Error(`Notification ${def.key}: buttons are WhatsApp quick replies; give a template`);
  return def;
}
