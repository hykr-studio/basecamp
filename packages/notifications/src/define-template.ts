import { createHash } from 'node:crypto';
import type { TemplateSpec } from '@app/channels';
import { LANGS, type Labels, type Lang } from '@app/i18n';
import type { z } from 'zod';

/**
 * A WhatsApp template, in code: reviewed in pull requests, synced to Meta by
 * `pnpm templates:sync`, checked before anything is sent. Outside the 24-hour window Meta only
 * delivers approved templates, and an approved template is never edited: a change is a new
 * version (meeting_reminder_v2), switched to once it is approved.
 */
export type TemplateButton =
  /** A reply button: its id comes back as the payload when tapped. */
  | { type: 'quick_reply'; id: string; text: Labels }
  /** A link: `path` is in the app, its {{1}} filled when sent. */
  | { type: 'url'; text: Labels; path: string };

export type TemplateDef<P extends z.ZodObject = z.ZodObject> = {
  /** snake_case with a version: meeting_reminder_v1. */
  name: string;
  category: 'utility' | 'marketing' | 'authentication';
  params: P;
  /** The text, per language, with named parameters: "Reminder: {{title}} at {{time}}." */
  body: Labels;
  /** A short line under the body (a marketing template's opt-out, for one). */
  footer?: Labels;
  buttons?: TemplateButton[];
  /** A value for every parameter: Meta's reviewers need samples. */
  example: z.infer<P>;
  /** Which URL button parameter fills the link's {{1}}, from the params. */
  urlParam?: keyof z.infer<P> & string;
};

const NAME = /^[a-z][a-z0-9_]*_v\d+$/;
const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

/** Refuse a template Meta would reject, or that could send a broken message. */
function check(def: TemplateDef) {
  const fail = (why: string) => {
    throw new Error(`Template ${def.name}: ${why}`);
  };
  if (!NAME.test(def.name)) fail('name it snake_case with a version, like meeting_reminder_v1');
  const keys = Object.keys(def.params.shape).sort();
  for (const lang of LANGS) {
    const body = def.body[lang];
    if (!body?.trim()) fail(`no ${lang} body`);
    if (body.length > 1024) fail(`the ${lang} body is over 1,024 characters`);
    if (JSON.stringify(placeholders(body)) !== JSON.stringify(keys))
      fail(`the ${lang} body's parameters (${placeholders(body)}) are not the schema's (${keys})`);
  }
  const quick = (def.buttons ?? []).filter((b) => b.type === 'quick_reply');
  if (quick.length > 3) fail('at most 3 quick-reply buttons');
  if (def.category === 'marketing' && quick.length === 0 && !def.footer)
    fail('a marketing template needs an opt-out button or footer');
  const example = def.params.safeParse(def.example);
  if (!example.success) fail(`the example does not fit the parameters: ${example.error.message}`);
  for (const k of keys)
    if (!String((def.example as Record<string, unknown>)[k] ?? '').trim())
      fail(`no example for ${k}`);
}

export function defineTemplate<P extends z.ZodObject>(def: TemplateDef<P>): TemplateDef<P> {
  check(def as unknown as TemplateDef);
  return def;
}

/** One language of a template, as the provider is asked to create it. */
export function toTemplateSpec(def: TemplateDef, lang: Lang, appUrl: string): TemplateSpec {
  const example = def.example as Record<string, unknown>;
  return {
    name: def.name,
    language: lang,
    category: def.category.toUpperCase() as TemplateSpec['category'],
    body: def.body[lang],
    examples: Object.fromEntries(Object.keys(def.params.shape).map((k) => [k, String(example[k])])),
    ...(def.footer ? { footer: def.footer[lang] } : {}),
    ...(def.buttons?.length
      ? {
          buttons: def.buttons.map((b) =>
            b.type === 'quick_reply'
              ? { type: 'QUICK_REPLY' as const, text: b.text[lang] }
              : {
                  type: 'URL' as const,
                  text: b.text[lang],
                  url: `${appUrl}${b.path}`,
                  example: `${appUrl}${b.path.replace('{{1}}', String(example[def.urlParam ?? ''] ?? 'example'))}`,
                },
          ),
        }
      : {}),
  };
}

/**
 * What is compared with what the provider holds: a changed template needs a new version. Its
 * own words only (not the app's address, which differs per environment).
 */
export function contentHash(def: TemplateDef, lang: Lang): string {
  const content = {
    category: def.category,
    body: def.body[lang],
    footer: def.footer?.[lang] ?? null,
    buttons: (def.buttons ?? []).map((b) =>
      b.type === 'quick_reply' ? ['quick_reply', b.text[lang]] : ['url', b.text[lang], b.path],
    ),
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}
