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

/**
 * Every template and notification: the framework's, then each module's, in order. Throws, listing
 * every problem, when a template name or a notification key is declared twice, or when a
 * notification names a template that is not in the catalog (it could never be sent).
 */
export function createNotificationCatalog(
  ...parts: readonly (NotificationsDomain | undefined)[]
): NotificationCatalog {
  const templates = [...frameworkTemplates, ...parts.flatMap((p) => p?.templates ?? [])];
  const notifications = [
    ...frameworkNotifications,
    ...parts.flatMap((p) => p?.notifications ?? []),
  ];
  const problems: string[] = [];
  const twice = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i);
  for (const name of new Set(twice(templates.map((t) => t.name))))
    problems.push(`The template ${name} is defined twice`);
  for (const key of new Set(twice(notifications.map((n) => n.key))))
    problems.push(`The notification ${key} is defined twice`);
  const known = new Set(templates.map((t) => t.name));
  for (const n of notifications) {
    const template = (n as { whatsapp?: { template?: TemplateDef } }).whatsapp?.template;
    if (template && !known.has(template.name))
      problems.push(
        `The notification ${n.key} sends ${template.name}, which is not a template here`,
      );
  }
  if (problems.length)
    throw new Error(`Modules do not fit together:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return { templates, notifications };
}

export * from './rules.js';
