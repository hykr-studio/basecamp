// The application's languages as schemas: a language an input may ask for (one the application
// declares), a stored language code, the set as the voice worker gets it, and words per
// language as they travel or as a business types them. @hykr/i18n holds the languages.
import { isLang, LANG_CODE, type Labels, type Lang as LangValue } from '@hykr/i18n';
import { z } from 'zod';

/**
 * A language the application speaks (`defineLanguages`, passed to `defineServer`): what an
 * input may ask for. Checked against the process's languages when it is parsed.
 */
export const Lang = z
  .string()
  .refine((v) => isLang(v), { error: "Not one of the application's languages" })
  .describe("A language code the application speaks (ISO 639: 'en' and the application's own)");
export type Lang = LangValue;

/**
 * A language code as stored or returned (a message's, a document's): its shape only, so a
 * language the application stops declaring never makes a stored row unreadable.
 */
export const LangCode = z.string().regex(LANG_CODE);

/**
 * The application's languages as the voice worker gets them (`Languages.toWire()`): it does
 * not load the application, so the dispatch carries them.
 */
export const LanguageWire = z.object({
  code: LangCode,
  name: z.string().min(1).max(100),
  english: z.string().min(1).max(100),
  locale: z.string().min(2).max(64),
  speech: z.string().min(2).max(64),
  letters: z
    .object({ source: z.string().min(1).max(2000), flags: z.string().regex(/^[imsuv]*$/) })
    .optional(),
});
export type LanguageWire = z.infer<typeof LanguageWire>;

/** Words per language as a response carries them: English, and any other language's. */
export const LabelsShape = z.object({ en: z.string() }).catchall(z.string().optional());

/**
 * Words a business types, per language: English required, any other optional (it reads in
 * English where it has none), an empty one dropped. `keys` checks each language: `LangCode`
 * where stored settings are read (a language the application stops declaring is kept, never
 * shown), `Lang` where a person writes (only the application's languages).
 */
export const typedLabels = (keys: z.ZodType<string>, words: z.ZodType<string>) =>
  z
    .record(keys, words)
    .refine((l) => Boolean(l.en), { error: 'Needs its English words', path: ['en'] })
    .transform(
      (l): Labels =>
        Object.fromEntries(Object.entries(l).filter(([, w]) => w !== '')) as unknown as Labels,
    );
