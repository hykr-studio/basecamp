import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contentHash, defineTemplate, toTemplateSpec } from './define-template.js';
import { notifications, templates } from './index.js';

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
    expect(templates.map((t) => t.name)).toContain('meeting_reminder_v1');
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
