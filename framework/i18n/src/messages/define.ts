import { LANGS, type Lang } from '../lang.js';

/** One feature's framework phrases, in every language, under the same keys. */
export type MessagePart<K extends string = string> = {
  readonly [L in Lang]: Readonly<Record<K, string>>;
};

/**
 * A feature's framework phrases, in its own file under messages/ and on its own line in
 * messages/index.ts. `en` sets the keys; every other language must have exactly those keys (a
 * missing or extra one does not compile). `{name}` is filled by t().
 */
export function defineMessages<const E extends Record<string, string>>(
  part: { en: E } & { [L in Exclude<Lang, 'en'>]: Record<keyof E, string> },
): MessagePart<Extract<keyof E, string>> {
  return part;
}

/** Every part merged into one catalog per language. A key in two parts throws. */
export function mergeMessages(parts: readonly MessagePart[]): Record<Lang, Record<string, string>> {
  const merged = Object.fromEntries(LANGS.map((lang) => [lang, {}])) as Record<
    Lang,
    Record<string, string>
  >;
  for (const part of parts)
    for (const lang of LANGS)
      for (const [key, phrase] of Object.entries(part[lang])) {
        if (lang === 'en' && key in merged.en)
          throw new Error(`The phrase "${key}" is defined in two message files`);
        merged[lang][key] = phrase;
      }
  return merged;
}
