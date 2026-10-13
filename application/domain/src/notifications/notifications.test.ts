// The application's templates: they pass Meta's rules, and every notification names one.
import { contentHash, createNotificationCatalog, toTemplateSpec } from '@hykr/notifications';
import { describe, expect, it } from 'vitest';
import { domainNotifications, domainTemplates } from './index.js';

const { notifications, templates } = createNotificationCatalog({
  templates: domainTemplates,
  notifications: domainNotifications,
});

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

  it('notifications name only templates that exist', () => {
    const names = new Set(templates.map((t) => t.name));
    for (const n of notifications) expect(names.has(n.whatsapp.template.name)).toBe(true);
  });
});
