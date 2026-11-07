import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineNotification } from './define-notification.js';
import { defineTemplate } from './define-template.js';
import { createNotificationCatalog } from './index.js';
import { overrideNotification, setEmailWording } from './override.js';

afterEach(() => setEmailWording(undefined));

const Calm = defineTemplate({
  name: 'calm_request_v1',
  category: 'utility',
  params: z.object({ summary: z.string().max(200) }),
  body: {
    en: 'Please look at: {{summary}}',
    hi: 'कृपया देखें: {{summary}}',
    te: 'దయచేసి చూడండి: {{summary}}',
  },
  buttons: [
    { type: 'quick_reply', id: 'approve', text: { en: 'Yes', hi: 'हाँ', te: 'అవును' } },
    { type: 'quick_reply', id: 'reject', text: { en: 'No', hi: 'नहीं', te: 'కాదు' } },
  ],
  example: { summary: 'Delete "Lamp"' },
});

const Reminder = defineNotification<{ id: string; tenantId: string; title: string }>({
  key: 'thing.reminder',
  topic: 'reminders',
  send: { on: ['thing.created'] },
  to: () => [{ roles: ['owner'] }],
  channels: ['email'],
  email: { subject: (r) => `Reminder: ${r.title}`, body: (r) => `Do ${r.title}` },
  dedupe: (r) => r.id,
});

describe('notification overrides (A11)', () => {
  it("rewords the framework's notification with another template, instead of declaring it twice", () => {
    const { notifications } = createNotificationCatalog(
      { templates: [Calm] },
      {
        overrides: [
          overrideNotification('approval.request', {
            whatsapp: { template: Calm, params: (a) => ({ summary: String(a.summary ?? '') }) },
          }),
        ],
      },
    );
    const def = notifications.find((n) => n.key === 'approval.request');
    expect(def?.whatsapp?.template.name).toBe('calm_request_v1');
  });

  it('refuses an override of nothing, two of one key, and a template the catalog lacks', () => {
    const patch = { channels: ['whatsapp' as const] };
    expect(() =>
      createNotificationCatalog({ overrides: [overrideNotification('no.such', patch)] }),
    ).toThrow(/not declared/);
    expect(() =>
      createNotificationCatalog({
        overrides: [
          overrideNotification('approval.outcome', patch),
          overrideNotification('approval.outcome', patch),
        ],
      }),
    ).toThrow(/overridden twice/);
    expect(() =>
      createNotificationCatalog({
        overrides: [
          overrideNotification('approval.request', {
            whatsapp: { template: Calm, params: () => ({ summary: 'x' }) },
          }),
        ],
      }),
    ).toThrow(/not a template here/);
  });

  it("a business's email words replace the application's at send time, {field} filled from the row", () => {
    const { notifications } = createNotificationCatalog({ notifications: [Reminder] });
    const def = notifications.find((n) => n.key === 'thing.reminder');
    const row = { id: '1', tenantId: 't1', title: 'Call back' };
    const reader = { lang: 'en' as const, timeZone: 'UTC' };
    expect(def?.email?.subject(row, reader)).toBe('Reminder: Call back');
    setEmailWording(({ tenantId, key, part }) =>
      tenantId === 't1' && key === 'thing.reminder' && part === 'subject'
        ? 'Heads up: {title}'
        : undefined,
    );
    expect(def?.email?.subject(row, reader)).toBe('Heads up: Call back');
    expect(def?.email?.body(row, reader)).toBe('Do Call back');
    expect(def?.email?.subject({ ...row, tenantId: 't2' }, reader)).toBe('Reminder: Call back');
  });
});
