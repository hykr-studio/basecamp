import type { Lang } from '../lang.js';

/** One feature's framework phrases: English, and the translations it ships, under its keys. */
export type MessagePart<K extends string = string> = {
  readonly en: Readonly<Record<K, string>>;
  readonly [lang: string]: Readonly<Partial<Record<K, string>>> | undefined;
};

/**
 * A feature's framework phrases, in its own file under messages/ and on its own line in
 * messages/index.ts. `en` sets the keys; a translation (any language) has some or all of them
 * and no other (an extra one does not compile). A phrase a translation lacks reads in English.
 * `{name}` is filled by t().
 */
export function defineMessages<const E extends Record<string, string>>(
  part: { readonly en: E } & {
    readonly [lang: string]: Readonly<Partial<Record<keyof E, string>>>;
  },
): MessagePart<Extract<keyof E, string>> {
  return part as MessagePart<Extract<keyof E, string>>;
}

/** Every part merged into one catalog per language. A key in two parts throws. */
export function mergeMessages(
  parts: readonly MessagePart[],
): { en: Record<string, string> } & Record<Lang, Record<string, string>> {
  const merged: { en: Record<string, string> } & Record<Lang, Record<string, string>> = { en: {} };
  for (const part of parts)
    for (const [lang, phrases] of Object.entries(part)) {
      merged[lang] ??= {};
      for (const [key, phrase] of Object.entries(phrases ?? {})) {
        if (lang === 'en' && key in merged.en)
          throw new Error(`The phrase "${key}" is defined in two message files`);
        merged[lang][key] = phrase as string;
      }
    }
  return merged;
}
