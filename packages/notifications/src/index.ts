// Templates and notifications as code: what may be sent, in which words, to whom and when.
// Definitions only (no database, queue or sending): the API's notify() and dispatcher run them.
import type { NotificationDef } from './define-notification.js';
import { domainNotifications, domainTemplates } from './domain/index.js';
import { frameworkNotifications } from './framework/notifications.js';
import { frameworkTemplates } from './framework/templates.js';

export * from './define-notification.js';
export * from './define-template.js';
export * from './framework/notifications.js';
export * from './framework/templates.js';

/** Every template, the framework's and the domain's: what `templates:sync` keeps at Meta. */
export const templates = [...frameworkTemplates, ...domainTemplates];
// biome-ignore lint/suspicious/noExplicitAny: notifications over different rows
export const notifications: NotificationDef<any>[] = [
  ...frameworkNotifications,
  ...domainNotifications,
];

const names = templates.map((t) => t.name);
const duplicate = names.find((n, i) => names.indexOf(n) !== i);
if (duplicate) throw new Error(`Template ${duplicate} is defined twice`);

export * from './rules.js';
