import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineNotification } from './define-notification.js';
import { contentHash, defineTemplate, toTemplateSpec } from './define-template.js';
import { CommentMentionNotification, createNotificationCatalog } from './index.js';

const { notifications, templates } = createNotificationCatalog();

const body = { en: 'Hi {{name}}', hi: 'नमस्ते {{name}}', te: 'నమస్తే {{name}}' };

describe('defineTemplate refuses what Meta would reject', () => {
  const ok = {
    name: 'hello_v1',
    category: 'utility' as const,
    params: z.object({ name: z.string() }),
    body,
    example: { name: 'Asha' },
  };

  it('a name without a version, mismatched parameters, a missing language', () => {
    expect(() => defineTemplate({ ...ok, name: 'hello' })).toThrow(/with a version/);
    expect(() => defineTemplate({ ...ok, body: { ...body, te: 'నమస్తే {{who}}' } })).toThrow(
      /te body's parameters/,
    );
    expect(() => defineTemplate({ ...ok, body: { ...body, hi: '' } })).toThrow(/no hi body/);
  });

  it('a marketing template without an opt-out; no example for a parameter', () => {
    expect(() => defineTemplate({ ...ok, category: 'marketing' })).toThrow(/opt-out/);
    expect(() => defineTemplate({ ...ok, example: { name: '' } })).toThrow(/no example for name/);
  });

  it('every template shipped passes, and has a stable hash per language', () => {
    expect(templates.map((t) => t.name)).toContain('approval_outcome_v1');
    const outcome = templates.find((t) => t.name === 'approval_outcome_v1');
    if (!outcome) throw new Error('missing');
    expect(contentHash(outcome, 'en')).toBe(contentHash(outcome, 'en'));
    expect(contentHash(outcome, 'en')).not.toBe(contentHash(outcome, 'hi'));
    const spec = toTemplateSpec(outcome, 'te', 'http://app');
    expect(spec).toMatchObject({ name: 'approval_outcome_v1', language: 'te' });
    expect(spec.examples).toEqual({ summary: 'Cancel the site visit', outcome: 'approved' });
  });

  it('an application template defined twice is refused', () => {
    const twice = defineTemplate({
      name: 'approval_outcome_v1',
      category: 'utility',
      params: z.object({ name: z.string() }),
      body,
      example: { name: 'Asha' },
    });
    expect(() => createNotificationCatalog({ templates: [twice] })).toThrow(/defined twice/);
  });

  it('notifications name only templates that exist', () => {
    const names = new Set(templates.map((t) => t.name));
    for (const n of notifications)
      if (n.whatsapp) expect(names.has(n.whatsapp.template.name)).toBe(true);
  });
});

describe('defineNotification', () => {
  const base = {
    key: 'x.done',
    topic: 'service' as const,
    to: () => [{ userId: 'u1' }],
    dedupe: (row: { id: string }) => `x.done:${row.id}`,
    email: { subject: () => 'Done', body: () => 'It is done.' },
  };

  it('needs no WhatsApp template when WhatsApp is not a channel', () => {
    expect(defineNotification({ ...base, channels: ['email'] }).whatsapp).toBeUndefined();
  });

  it('needs a template for WhatsApp, and WhatsApp for buttons; a channel once', () => {
    expect(() => defineNotification({ ...base, channels: ['whatsapp', 'email'] })).toThrow(
      /WhatsApp is a channel but has no template/,
    );
    expect(() =>
      defineNotification({ ...base, channels: ['email'], onButton: { ok: () => undefined } }),
    ).toThrow(/quick replies/);
    expect(() => defineNotification({ ...base, channels: ['email', 'email'] })).toThrow(
      /named twice/,
    );
  });

  it('needs a title and body for push, and nothing else', () => {
    expect(() => defineNotification({ ...base, channels: ['push', 'email'] })).toThrow(
      /push is a channel but has no title and body/,
    );
    const push = { title: () => 'Done', body: () => 'It is done.', url: () => '/x' };
    expect(defineNotification({ ...base, channels: ['push', 'email'], push }).push).toBe(push);
  });

  it('needs a title and body for the in-app inbox', () => {
    expect(() => defineNotification({ ...base, channels: ['inapp'] })).toThrow(
      /inapp is a channel but has no title and body/,
    );
    const inapp = { title: () => 'Done', body: () => 'It is done.' };
    expect(defineNotification({ ...base, channels: ['inapp', 'email'], inapp }).inapp).toBe(inapp);
  });

  it("the framework's mention notification: the inbox, for a person named, in their words", () => {
    const n = CommentMentionNotification;
    expect(n.channels).toEqual(['inapp']);
    expect(n.send?.on).toEqual(['comment.mentioned']);
    const row = {
      id: 'c1',
      tenantId: 't1',
      commentId: 'c1',
      on: { entity: 'task', id: 'r1' },
      target: { kind: 'user', id: 'u2', label: 'Ravi' },
      author: { id: 'u1', name: 'Ana' },
      internal: false,
      excerpt: 'Can you check @Ravi?',
    };
    expect(n.when?.(row)).toBe(true);
    expect(n.when?.({ ...row, target: { kind: 'other', id: 'a1', label: 'Bot' } })).toBe(false);
    expect(n.to(row)).toEqual([{ userId: 'u2' }]);
    expect(n.inapp?.title(row, { lang: 'en', timeZone: 'UTC' })).toBe('Ana mentioned you');
    expect(n.inapp?.title(row, { lang: 'hi', timeZone: 'UTC' })).toContain('Ana');
    expect(n.inapp?.body(row, { lang: 'en', timeZone: 'UTC' })).toBe('Can you check @Ravi?');
    expect(n.inapp?.record?.(row)).toEqual({ type: 'task', id: 'r1' });
    expect(n.dedupe(row)).toBe('comment.mention:c1:user:u2');
    expect(notifications.map((x) => x.key)).toContain('comment.mention');
  });
});
