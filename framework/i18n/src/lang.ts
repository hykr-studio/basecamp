/**
 * The languages an application speaks. The application declares them (`defineLanguages`), and
 * English is always one of them: the fallback everywhere, for a word missing in a language, an
 * unknown locale, or a language a person picked that the application does not speak. The
 * framework names no other language; its phrases ship in English plus the translations it has.
 */

/** A language's code: ISO 639 ('en', 'de'), the key of its words in Labels. */
export type Lang = string;

/** Something in each language: English always, the application's other languages when given. */
export type PerLang<T> = { readonly en: T; readonly [lang: string]: T | undefined };

/** One phrase: English always; each other language optional, falling back to English. */
export type Labels = PerLang<string>;

/** A noun, singular then plural: "to-do" / "to-dos". */
export type Noun = PerLang<readonly [one: string, many: string]>;

/** One language, as an application declares it. */
export type LanguageDef = {
  /** Its name in its own script: what a language picker shows ("Deutsch"). */
  name: string;
  /** Its name in English: how instructions to a model name it ("Reply in German."). */
  english: string;
  /** The Intl locale its dates, numbers, money and plurals are written in. Default: its code. */
  locale?: string;
  /** The BCP 47 tag speech-to-text and text-to-speech are asked for. Default: its locale. */
  speech?: string;
  /**
   * The letters of its script (tested one character at a time): how a typed or transcribed
   * text is known to be in it. Without letters, a text is never taken to be in this language.
   */
  letters?: RegExp;
  /** WhatsApp keywords in this language, by keyword ('stop', 'help'…): whole-message words. */
  keywords?: Readonly<Record<string, readonly string[]>>;
};

/** A declared language, its defaults filled in. */
export type Language = {
  readonly code: Lang;
  readonly name: string;
  readonly english: string;
  readonly locale: string;
  readonly speech: string;
  readonly letters?: RegExp;
  readonly keywords: Readonly<Record<string, readonly string[]>>;
};

/** A language as it travels (the voice worker's dispatch): JSON, the letters as a pattern. */
export type LanguageWire = {
  code: Lang;
  name: string;
  english: string;
  locale: string;
  speech: string;
  letters?: { source: string; flags: string };
};

/** The languages one application speaks: English first, then the others as declared. */
export interface Languages {
  /** Every code, English first. */
  readonly codes: readonly Lang[];
  /** Every language, English first. */
  readonly list: readonly Language[];
  /** Is this one of them? */
  has(code: unknown): code is Lang;
  get(code: Lang): Language | undefined;
  /** The declared language of a locale or speech tag: 'de-AT' → 'de'; anything else undefined. */
  of(tag: string | null | undefined): Lang | undefined;
  /**
   * The language a text is written in, by its letters: the other languages first, in their
   * order, then English, so a code-mixed line counts as the language that is not English.
   * Digits and punctuation alone say nothing.
   */
  scriptOf(text: string): Lang | undefined;
  /** How many letters of each language's script a text has (languages with letters only). */
  scriptCounts(text: string): Readonly<Record<Lang, number>>;
  /** The set as JSON, for a process that does not load the application. */
  toWire(): LanguageWire[];
}

/** A language code as written: two or three lower-case letters (ISO 639). */
export const LANG_CODE = /^[a-z]{2,3}$/;

/** English as the framework knows it; an application may change any of it. */
const ENGLISH: LanguageDef = {
  name: 'English',
  english: 'English',
  locale: 'en-GB',
  letters: /[a-z]/i,
};

/** One character at a time: a global or sticky pattern would carry its position between tests. */
const stateless = (re: RegExp) =>
  re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re;

const FIELDS = new Set(['name', 'english', 'locale', 'speech', 'letters', 'keywords']);

function language(code: Lang, def: Partial<LanguageDef>): Language {
  const problems: string[] = [];
  for (const field of Object.keys(def))
    if (!FIELDS.has(field)) problems.push(`"${code}": "${field}" is not part of a language`);
  if (!LANG_CODE.test(code)) problems.push(`"${code}" is not a language code (ISO 639, like "de")`);
  if (!def.name?.trim()) problems.push(`"${code}" needs its name (in its own script)`);
  if (!def.english?.trim()) problems.push(`"${code}" needs its name in English`);
  const locale = def.locale ?? code;
  try {
    new Intl.DateTimeFormat(locale);
  } catch {
    problems.push(`"${code}": "${locale}" is not a locale`);
  }
  if (problems.length) throw new Error(`Languages:\n- ${problems.join('\n- ')}`);
  return {
    code,
    name: def.name as string,
    english: def.english as string,
    locale,
    speech: def.speech ?? locale,
    ...(def.letters ? { letters: stateless(def.letters) } : {}),
    keywords: def.keywords ?? {},
  };
}

function languageSet(list: readonly Language[]): Languages {
  const byCode = new Map(list.map((l) => [l.code, l]));
  // The languages a text is tested against: the others first, English last.
  const scripts = [...list.slice(1), list[0]].filter((l) => l.letters);
  const has = (code: unknown): code is Lang => typeof code === 'string' && byCode.has(code);
  return {
    codes: list.map((l) => l.code),
    list,
    has,
    get: (code) => byCode.get(code),
    of(tag) {
      const base = tag?.toLowerCase().split(/[-_]/)[0];
      return has(base) ? base : undefined;
    },
    scriptOf(text) {
      return scripts.find((l) => (l.letters as RegExp).test(text))?.code;
    },
    scriptCounts(text) {
      const chars = [...text];
      return Object.fromEntries(
        scripts.map((l) => [l.code, chars.filter((c) => (l.letters as RegExp).test(c)).length]),
      );
    },
    toWire: () =>
      list.map((l) => ({
        code: l.code,
        name: l.name,
        english: l.english,
        locale: l.locale,
        speech: l.speech,
        ...(l.letters ? { letters: { source: l.letters.source, flags: l.letters.flags } } : {}),
      })),
  };
}

/**
 * The languages an application speaks, declared once in a file its server and its app both
 * import, and passed to `defineServer({ languages })` and `<AppShell config={{ languages }}>`.
 * English comes first and is added when left out; give `en` to change its locale, speech tag
 * or keywords. The others follow in the order given (a language picker's order).
 */
export function defineLanguages<const D extends Record<string, Partial<LanguageDef>>>(
  defs: D & { readonly [K in Exclude<keyof D, 'en'>]: LanguageDef },
): Languages {
  const given = defs as Record<string, Partial<LanguageDef>>;
  return languageSet([
    language('en', { ...ENGLISH, ...given.en }),
    ...Object.entries(given)
      .filter(([code]) => code !== 'en')
      .map(([code, def]) => language(code, def)),
  ]);
}

/** A set sent by `toWire()`, rebuilt (the voice worker, from its dispatch). */
export function languagesFromWire(wire: readonly LanguageWire[]): Languages {
  const defs: Record<string, LanguageDef> = {};
  for (const l of wire)
    defs[l.code] = {
      name: l.name,
      english: l.english,
      locale: l.locale,
      speech: l.speech,
      ...(l.letters ? { letters: new RegExp(l.letters.source, l.letters.flags) } : {}),
    };
  return defineLanguages(defs);
}

const ENGLISH_ONLY = defineLanguages({});
let current: Languages = ENGLISH_ONLY;

/** The languages this process speaks: the application's, or English alone until it says. */
export const languages = (): Languages => current;

/**
 * Speak these languages in this process: the server's runtime and the app's configuration call
 * it with the application's declaration.
 */
export function setLanguages(set: Languages): void {
  current = set;
}

/** Back to English alone (tests). */
export function resetLanguages(): void {
  current = ENGLISH_ONLY;
}

/** Is it one of the languages this process speaks? */
export const isLang = (value: unknown): value is Lang => current.has(value);

/** The language of a locale or a voice language: 'de-AT' → 'de' if declared, else 'en'. */
export function langOf(tag: string | null | undefined): Lang {
  return current.of(tag) ?? 'en';
}

/** The entry for this language, or English's when it has none (or an empty string). */
export function pick<T>(table: PerLang<T>, lang: Lang): T {
  const own = table[lang];
  return own === undefined || own === '' ? table.en : own;
}

const english = () => current.get('en') as Language;

/** A language's name in its own script ("Deutsch"); its code when it is not declared. */
export const languageName = (lang: Lang): string => current.get(lang)?.name ?? lang;

/** A language's name in English ("German"); its code when it is not declared. */
export const englishName = (lang: Lang): string => current.get(lang)?.english ?? lang;

/** The Intl locale a language is written in; English's for a language not declared. */
export const localeOf = (lang: Lang): string => (current.get(lang) ?? english()).locale;

/** The speech tag a language is heard and spoken in; English's for a language not declared. */
export const speechTagOf = (lang: Lang): string => (current.get(lang) ?? english()).speech;

/** The language a text is written in, by its letters (see `Languages.scriptOf`). */
export const scriptOf = (text: string, set: Languages = current): Lang | undefined =>
  set.scriptOf(text);

/** How many letters of each language's script a text has: which language most of it is in. */
export const scriptCounts = (text: string, set: Languages = current) => set.scriptCounts(text);
