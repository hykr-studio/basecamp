/**
 * The languages the product speaks. English is the fallback everywhere: a missing word, an
 * unknown locale, a language the person picked that a catalog does not have yet.
 */
export const LANGS = ['en', 'hi', 'te'] as const;
export type Lang = (typeof LANGS)[number];

/** One phrase in every language; the type makes a missing translation a compile error. */
export type Labels = Readonly<Record<Lang, string>>;

/** A noun in every language, singular then plural: "to-do" / "to-dos". */
export type Noun = Readonly<Record<Lang, readonly [one: string, many: string]>>;

export const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang);

/** The language of a locale or a voice language: 'hi-IN' → 'hi', 'te' → 'te', 'auto' → 'en'. */
export function langOf(tag: string | null | undefined): Lang {
  const base = tag?.toLowerCase().split(/[-_]/)[0];
  return isLang(base) ? base : 'en';
}

/** The phrase in this language. */
export const pick = (labels: Labels, lang: Lang): string => labels[lang] || labels.en;

/** Each language's name, in its own script: what a language picker shows. */
export const LANG_NAMES: Labels = { en: 'English', hi: 'हिंदी', te: 'తెలుగు' };

/** Each language's name in English: how instructions to a model name it ("Reply in Telugu."). */
export const LANG_ENGLISH_NAMES: Labels = { en: 'English', hi: 'Hindi', te: 'Telugu' };

/**
 * The language a text is written in, by its script: Telugu or Devanagari letters read as
 * Telugu or Hindi, Latin letters as English; digits and punctuation alone say nothing.
 */
export function scriptOf(text: string): Lang | undefined {
  if (TELUGU.test(text)) return 'te';
  if (DEVANAGARI.test(text)) return 'hi';
  return /[a-z]/i.test(text) ? 'en' : undefined;
}

/** Letters only: the dandas (। ॥) and the abbreviation sign (॰) are punctuation. */
export const DEVANAGARI = /[\u0900-\u0963\u0966-\u096F\u0971-\u097F]/;
export const TELUGU = /[\u0C00-\u0C7F]/;

/** How many letters of each script a text has: which language most of it is in. */
export function scriptCounts(text: string): Record<Lang, number> {
  const count = (re: RegExp) => [...text].filter((c) => re.test(c)).length;
  return { en: count(/[a-z]/i), hi: count(DEVANAGARI), te: count(TELUGU) };
}
