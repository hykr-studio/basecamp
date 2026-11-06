import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineNotification } from './define-notification.js';
import { contentHash, defineTemplate, toTemplateSpec } from './define-template.js';
import { createNotificationCatalog } from './index.js';

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
});

describe('an approval request', () => {
  const request = notifications.find((n) => n.key === 'approval.request');
  const row = (fields: Record<string, unknown>) =>
    ({
      id: 'a1',
      tenantId: 't1',
      summary: 'Pay the supplier',
      status: 'pending',
      ownerId: 'u-asked',
      approverUserId: null,
      approverCapability: null,
      approverChannels: null,
      requesterContactId: null,
      ...fields,
    }) as never;

  it("goes to a capability's holders, never to the requester", () => {
    const a = row({ approverCapability: 'approvals.decide' });
    expect(request?.when?.(a)).toBe(true);
    expect(request?.to(a)).toEqual([{ capability: 'approvals.decide', except: ['u-asked'] }]);
  });

  it('goes to a named person alone', () => {
    const a = row({ approverUserId: 'u-named' });
    expect(request?.when?.(a)).toBe(true);
    expect(request?.to(a)).toEqual([{ userId: 'u-named' }]);
  });

  it('not when the requester decides it, nor when it is decided in the app only', () => {
    expect(request?.when?.(row({ approverUserId: 'u-asked' }))).toBe(false);
    expect(
      request?.when?.(row({ approverCapability: 'approvals.decide', approverChannels: ['app'] })),
    ).toBe(false);
  });
});
