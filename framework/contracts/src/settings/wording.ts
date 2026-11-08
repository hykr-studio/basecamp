// A business's own words (A11): framework phrases and notification emails it words its own way.
// The application's overrides (`overridePhrases`, `overrideNotification`) come first; these
// replace them for one business.
import { catalogs, isLang, type Lang, type MessageKey, t } from '@hykr/i18n';
import { z } from 'zod';
import { Lang as DeclaredLang, LangCode } from '../languages.js';
import { defineSettingsSection } from './sections.js';

declare module './sections.js' {
  interface TenantSettingsSections {
    wording: Wording;
  }
}

const words = z.string().min(1).max(1000);

/**
 * Some languages' words, as stored: a language left out keeps the application's. Any language
 * code is kept (one the application stops declaring is never read).
 */
export const SomeLabels = z.record(LangCode, words);
export type SomeLabels = z.infer<typeof SomeLabels>;

/** Some languages' words as a person writes them: only the application's languages. */
export const SomeLabelsInput = z.record(DeclaredLang, words);

/** A notification's email, worded by the business. `{field}` is filled from the record. */
export const EmailWording = z
  .object({ subject: SomeLabels.optional(), body: SomeLabels.optional() })
  .strict();
const EmailWordingInput = z
  .object({ subject: SomeLabelsInput.optional(), body: SomeLabelsInput.optional() })
  .strict();

export const Wording = z
  .object({
    /** Framework phrases by key ('channel.handoff'). */
    phrases: z.record(z.string(), SomeLabels).default({}),
    /** Notifications by key ('approval.request'). */
    notifications: z.record(z.string(), z.object({ email: EmailWording.optional() })).default({}),
  })
  .default({ phrases: {}, notifications: {} });
export type Wording = z.infer<typeof Wording>;

export const WordingSection = defineSettingsSection('wording', Wording);

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/**
 * Problems with a business's phrases: a key that is no framework phrase, words in a language
 * the application does not speak, or words whose `{placeholders}` differ from the phrase they
 * replace (the filled-in values would be lost).
 */
export function phraseProblems(phrases: Readonly<Record<string, SomeLabels>>): string[] {
  const problems: string[] = [];
  for (const [key, labels] of Object.entries(phrases)) {
    const base = (catalogs.en as Record<string, string>)[key];
    if (base === undefined) {
      problems.push(`"${key}" is not a phrase`);
      continue;
    }
    const want = placeholders(base).join(',');
    for (const [lang, words] of Object.entries(labels)) {
      if (!isLang(lang))
        problems.push(`"${key}" (${lang}): not one of the application's languages`);
      else if (placeholders(words).join(',') !== want)
        problems.push(`"${key}" (${lang}) must keep the placeholders {${want || 'none'}}`);
    }
  }
  return problems;
}

/**
 * A framework phrase as one business words it: its own words for this language, or else the
 * process's (`t`). Use it where the business's settings are at hand.
 */
export function tenantPhrase(
  settings: { wording?: Pick<Wording, 'phrases'> } | undefined,
  lang: Lang,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const own = settings?.wording?.phrases?.[key]?.[lang];
  if (!own) return t(lang, key, vars);
  return own.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** A change to the wording: each key sent replaces that key's words; null removes it. */
export const WordingPatch = z
  .object({
    phrases: z.record(z.string(), SomeLabelsInput.nullable()).optional(),
    notifications: z
      .record(z.string(), z.object({ email: EmailWordingInput.optional() }).nullable())
      .optional(),
  })
  .strict();
export type WordingPatch = z.infer<typeof WordingPatch>;
