import type { Lang } from './lang.js';
import { type MessagePart, mergeMessages } from './messages/define.js';
import * as parts from './messages/index.js';

/**
 * The framework's own words: what the assistant says about the screen, approvals, the voice
 * controls and the channels. Each feature keeps its phrases in messages/<feature>.ts
 * (`defineMessages`), listed in messages/index.ts. A domain's words (view titles, field names,
 * its verbs) live with the domain, as Labels. `{name}` is filled by t().
 */
type Parts = typeof parts;

/** Every framework phrase's key: the keys of every part. */
export type MessageKey = {
  [P in keyof Parts]: Parts[P] extends MessagePart<infer K> ? K : never;
}[keyof Parts];
type Catalog = Readonly<Record<MessageKey, string>>;

export const catalogs = mergeMessages(Object.values(parts)) as Readonly<Record<Lang, Catalog>>;

/** Some languages' words for some phrases: what an override gives. */
export type PhraseOverrides = {
  readonly [L in Lang]?: Readonly<Partial<Record<MessageKey, string>>>;
};

/** The application's words (`overridePhrases`), then one business's (`setTenantPhrases`). */
const applicationLayer: Record<Lang, Record<string, string>> = { en: {}, hi: {}, te: {} };
let tenantLayer: Record<string, Partial<Record<Lang, string>>> = {};

const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

/**
 * Word framework phrases the application's way, in this process (the server's entry, the app's
 * root). Each phrase must exist and keep the `{placeholders}` of the phrase it replaces; a
 * phrase overridden twice throws, so two modules never fight over one.
 */
export function overridePhrases(part: PhraseOverrides): void {
  const problems: string[] = [];
  for (const [lang, phrases] of Object.entries(part) as [Lang, Record<string, string>][]) {
    if (!catalogs[lang]) {
      problems.push(`"${lang}" is not a language`);
      continue;
    }
    for (const [key, words] of Object.entries(phrases ?? {})) {
      const base = (catalogs.en as Record<string, string>)[key];
      if (base === undefined) problems.push(`"${key}" is not a phrase`);
      else if (placeholders(words) !== placeholders(base))
        problems.push(`"${key}" (${lang}) must keep the placeholders of "${base}"`);
      else if (key in applicationLayer[lang])
        problems.push(`"${key}" (${lang}) is overridden twice`);
    }
  }
  if (problems.length) throw new Error(`Phrase overrides:\n- ${problems.join('\n- ')}`);
  for (const [lang, phrases] of Object.entries(part) as [Lang, Record<string, string>][])
    Object.assign(applicationLayer[lang], phrases);
}

/**
 * One business's own words for framework phrases (its `wording.phrases` settings), on top of the
 * application's: the app sets them for the business it shows. Replaces the previous business's.
 */
export function setTenantPhrases(phrases: Readonly<Record<string, Partial<Record<Lang, string>>>>) {
  tenantLayer = { ...phrases };
}

/** Forget every override (tests). */
export function resetPhraseOverrides(): void {
  for (const lang of Object.keys(applicationLayer) as Lang[]) applicationLayer[lang] = {};
  tenantLayer = {};
}

/**
 * A framework phrase in this language, with {name} filled from vars: the business's words, the
 * application's, or the framework's.
 */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const phrase =
    tenantLayer[key]?.[lang] ||
    applicationLayer[lang]?.[key] ||
    catalogs[lang][key] ||
    applicationLayer.en[key] ||
    catalogs.en[key];
  return phrase.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
