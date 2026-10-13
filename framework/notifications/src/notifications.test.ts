import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    for (const n of notifications) expect(names.has(n.whatsapp.template.name)).toBe(true);
  });
});
