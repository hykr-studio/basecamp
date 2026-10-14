// Templates and notifications as code: what may be sent, in which words, to whom and when.
// Definitions only (no database, queue or sending): the API's notify() and dispatcher run them.
import type { NotificationDef } from './define-notification.js';
import type { TemplateDef } from './define-template.js';
import { frameworkNotifications } from './framework/notifications.js';
import { frameworkTemplates } from './framework/templates.js';

export * from './define-notification.js';
export * from './define-template.js';
export * from './framework/notifications.js';
export * from './framework/templates.js';

/** What an application sends on its own initiative: its templates and its notifications. */
export interface NotificationsDomain {
  templates?: readonly TemplateDef[];
  // biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
  notifications?: readonly NotificationDef<any>[];
}

export interface NotificationCatalog {
  /** Every template, the framework's and the application's: what `templates:sync` keeps at Meta. */
  templates: readonly TemplateDef[];
  // biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
  notifications: readonly NotificationDef<any>[];
}

export function createNotificationCatalog(domain: NotificationsDomain = {}): NotificationCatalog {
  const templates = [...frameworkTemplates, ...(domain.templates ?? [])];
  const names = templates.map((t) => t.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Template ${duplicate} is defined twice`);
  return {
    templates,
    notifications: [...frameworkNotifications, ...(domain.notifications ?? [])],
  };
}

export * from './rules.js';
