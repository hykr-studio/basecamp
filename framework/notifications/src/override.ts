// Wording overrides (A11): an application rewords a notification it did not declare (the
// framework's, or an earlier module's) instead of declaring the key again, and a business words
// a notification's email its own way.
import type { Lang } from '@hykr/i18n';
import { defineNotification, type NotificationDef, type Row } from './define-notification.js';

/**
 * What an override may change: the channels (the chain and `also`), the WhatsApp template
 * (another template the catalog holds: approved wording is never edited, it is replaced), the
 * email, the push and the in-app inbox's words.
 */
export type NotificationPatch = Partial<
  Pick<NotificationDef<Row>, 'channels' | 'also' | 'whatsapp' | 'email' | 'push' | 'inapp'>
>;

export interface NotificationOverride {
  /** The notification it changes ('approval.request'). */
  key: string;
  patch: NotificationPatch;
}

/** Reword the notification `key`. Pass it in `defineServer({ wording: { notifications } })`. */
export function overrideNotification(key: string, patch: NotificationPatch): NotificationOverride {
  if (!Object.keys(patch).length) throw new Error(`Notification override ${key}: change something`);
  return { key, patch };
}

/** Apply the overrides: an unknown key or a key overridden twice is a problem. */
export function applyOverrides(
  // biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
  notifications: NotificationDef<any>[],
  overrides: readonly NotificationOverride[],
  problems: string[],
): void {
  const seen = new Set<string>();
  for (const o of overrides) {
    if (seen.has(o.key)) problems.push(`The notification ${o.key} is overridden twice`);
    seen.add(o.key);
    const at = notifications.findIndex((n) => n.key === o.key);
    if (at < 0) {
      problems.push(`An override names the notification ${o.key}, which is not declared`);
      continue;
    }
    try {
      notifications[at] = defineNotification({ ...notifications[at], ...o.patch });
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * A business's own words for a notification's email, if it has any: the API's settings feature
 * installs this. Return undefined to keep the application's.
 */
export type EmailWordingResolver = (a: {
  tenantId: string;
  key: string;
  part: 'subject' | 'body';
  lang: Lang;
  row: Row;
}) => string | undefined;

let resolver: EmailWordingResolver | undefined;

/** Install the resolver (once per process; the settings feature does). */
export function setEmailWording(fn: EmailWordingResolver | undefined): void {
  resolver = fn;
}

/** `{field}` filled from the record's own values. */
const fill = (words: string, row: Row) =>
  words.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = row[name];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : whole;
  });

/** The email functions of a notification, asking the business's wording first. */
// biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
export function withTenantEmail(def: NotificationDef<any>): NotificationDef<any> {
  const email = def.email;
  if (!email) return def;
  const part =
    (
      name: 'subject' | 'body',
      own: (row: Row, reader: { lang: Lang; timeZone: string }) => string,
    ) =>
    (row: Row, reader: { lang: Lang; timeZone: string }) => {
      const words = resolver?.({
        tenantId: row.tenantId,
        key: def.key,
        part: name,
        lang: reader.lang,
        row,
      });
      return words ? fill(words, row) : own(row, reader);
    };
  return {
    ...def,
    email: { subject: part('subject', email.subject), body: part('body', email.body) },
  };
}
