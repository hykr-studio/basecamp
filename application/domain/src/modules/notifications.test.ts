// The modules' templates: they pass Meta's rules, and every notification names one.
import { contentHash, createNotificationCatalog, toTemplateSpec } from '@hykr/notifications';
import { describe, expect, it } from 'vitest';
import { accountNotifications } from './account/notifications/index.js';
import { meetingsNotifications } from './meetings/notifications/index.js';
import { todosNotifications } from './todos/notifications/index.js';

const { notifications, templates } = createNotificationCatalog(
  todosNotifications,
  meetingsNotifications,
  accountNotifications,
);

describe('the application’s templates and notifications', () => {
  it('the reminder template has a stable hash per language', () => {
    const reminder = templates.find((t) => t.name === 'meeting_reminder_v1');
    if (!reminder) throw new Error('missing');
    expect(contentHash(reminder, 'en')).toBe(contentHash(reminder, 'en'));
    expect(contentHash(reminder, 'en')).not.toBe(contentHash(reminder, 'hi'));
    const spec = toTemplateSpec(reminder, 'te', 'http://app');
    expect(spec).toMatchObject({
      name: 'meeting_reminder_v1',
      language: 'te',
      category: 'UTILITY',
    });
    expect(spec.examples).toEqual({ title: 'Site visit', time: '4:30 pm' });
  });

  it('the to-do reminder goes to the phone first, in the reader’s language', () => {
    const due = notifications.find((n) => n.key === 'todo.due');
    expect(due?.channels).toEqual(['push', 'whatsapp', 'email']);
    const row = { id: 't1', tenantId: 'b1', title: 'Order tiles', dueOn: '2026-11-06' };
    expect(due?.push?.title(row, { lang: 'hi', timeZone: 'Asia/Kolkata' })).toBe('आज करना है');
    expect(due?.push?.body(row, { lang: 'en', timeZone: 'Asia/Kolkata' })).toBe('Order tiles');
    expect(due?.push?.url?.(row)).toBe('/todos');
  });

  it('notifications name only templates that exist', () => {
    const names = new Set(templates.map((t) => t.name));
    for (const n of notifications)
      if (n.whatsapp) expect(names.has(n.whatsapp.template.name)).toBe(true);
  });
});
