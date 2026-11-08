# HLANG: the application declares its languages

## Summary

The languages a product speaks change with the business, but `@hykr/i18n` fixed them:
`LANGS = ['en', 'hi', 'te']`, `Labels = Record<'en' | 'hi' | 'te', string>`, the voice tags
`en-IN`, `hi-IN` and `te-IN`, the Devanagari and Telugu letter ranges, and the names English,
Hindi and Telugu were framework constants. An application for another market could not add a
language, and could not leave one out.

Now the application declares its languages (`defineLanguages`), once, in an isomorphic file both
halves import: the server gets them through `defineServer({ languages })`, the app through
`<AppShell config={{ languages }}>`, and the voice worker from the API's dispatch of each
session. English is always one of them and is every word's fallback. Every other language is
optional everywhere: `Labels` needs `en`, takes any declared language, and a missing one reads
as English. The framework's own phrases ship in English plus the translations it has (Hindi and
Telugu today); an application adds words for a language the framework lacks with its
`wording.phrases`. Language detection (WhatsApp, voice, the scripted model, the eval scorer)
reads each declared language's letters; speech uses each language's own speech tag; WhatsApp
keywords take each language's words; templates are synced and sent in the languages they have.

The sample declares English, Hindi and Telugu with the locales, speech tags and letters the
framework had, so nothing it shows or says changes.

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | `defineLanguages({ en?, <code>: LanguageDef, ... })` (`@hykr/i18n`) builds a `Languages` set; English comes first, then the others in declaration order. A code is ISO 639 (`/^[a-z]{2,3}$/`). `en` may be given to change English's locale, speech tag or keywords; it is added when left out. With no declaration a process speaks English only. | Task ("en is required and other languages are optional"); default (English is the framework's own language and every fallback). |
| 2 | A language is `{ name, english, locale?, speech?, letters?, keywords? }`: its name in its own script (a picker), its name in English (the model's "Reply in Hindi."), the Intl locale (dates, numbers, money, plurals; default its code), the BCP 47 tag speech-to-text and text-to-speech are asked for (default its locale), a RegExp of its script's letters (how a typed or transcribed text is recognised; none: never detected from text), and WhatsApp keyword words by keyword. | Task ("voice and WhatsApp language detection"); the values the framework hard-coded (`LOCALE`, `${lang}-IN`, `DEVANAGARI`, `TELUGU`, `LANG_NAMES`, `LANG_ENGLISH_NAMES`). |
| 3 | English's defaults: name and English name `English`, locale `en-GB` (day-month order, 24-hour clock), speech tag the locale, letters `/[a-z]/i`. `en-GB` is kept as the neutral default because every framework date format and test reads it; an application changes it in its declaration. | Default: keeps framework output unchanged; the plan's rule that framework defaults are neutral and overridable. |
| 4 | One set per process: `setLanguages(set)` installs it; `languages()` reads it. `setRuntime` installs the definition's set before the application's phrase overrides (API, worker, CLI, tests); `configure({ languages })` installs it in the app. The voice worker builds its set from the dispatch (decision 11). | Task ("e.g. via defineServer and the AppShell config"); existing pattern (`overridePhrases` in `setRuntime`). |
| 5 | `Lang` is `string` (a declared code). `PerLang<T>` is `{ en: T; [lang: string]: T \| undefined }`; `Labels = PerLang<string>`; `Noun = PerLang<[one, many]>`. `pick(table, lang)` gives the language's entry, else English's (an empty string counts as missing). A missing translation now compiles; an application that wants every word in every language checks it in its tests (decision 14). | Task ("en is required and other languages are optional, falling back to en"). |
| 6 | The zod `Lang` (`@hykr/contracts`) accepts a declared code only and is used for inputs (a chat turn, a document or acceptance request, a link code). Stored and returned values (a thread message's language, a document's, an acceptance's) use `LangCode`, which checks the shape only, so a language the application stops declaring never makes a stored row unreadable. `VoiceLang` is `'auto'` or a declared code. | Default: fail closed on input, never on stored data. |
| 7 | The framework's phrases: `defineMessages({ en, ...translations })` takes any language, each with some or all of English's keys and no other; the shipped Hindi and Telugu stay complete (a test). `t(lang, key)` reads the business's words, then the application's, then the framework's translation, then English. `overridePhrases` accepts any declared language, so an application words framework phrases in a language the framework has no translation for. | Task ("the framework's own phrases ship en plus whatever translations exist"). |
| 8 | Recognising a text's language: `scriptOf(text)` tries each language's `letters`, the other languages first in declaration order, English last (so "జోడించు Call the plumber" is Telugu, as before). Two languages with one script: the first declared wins. `scriptCounts` counts letters per language that has letters. | Default: the previous order (Telugu, Devanagari, then Latin), generalised. |
| 9 | WhatsApp: the language a contact writes in is the language whose letters the text has, when it is not English (it sticks to the contact); else the contact's. Keywords: the framework's own words (English, Hindi, Telugu) always match, whether declared or not (an opt-out is never missed), plus each declared language's `keywords`. A keyword name the channels do not know is a boot problem. | Task ("WhatsApp language detection"); default (consent words fail safe). |
| 10 | Voice: the session's language travels as a code (`'te'`, was `'te-IN'`); the speech provider and the device's recognizer and reader are asked for the language's `speech` tag. The language chip cycles through Auto and the declared languages, named in their own script. | Task ("voice ... language detection", "the apps"); the region was a provider and market detail. |
| 11 | The voice worker never imports the application: the API puts the set on the session's dispatch (`VoiceDispatch.languages`: code, names, locale, speech tag, the letters' source and flags), and the worker's `LangState` uses it. | Framework rule (the worker reaches the API only over HTTP); default (the dispatch is already the API's trusted word to the worker). |
| 12 | Templates: `body` needs English; another language is optional. `basecamp templates sync` creates, per template, the declared languages it has a body for. A send uses the contact's language when the template has it and it is approved, else English (the existing fallback). A template's checks run on each language it has. | Task (threading); Meta needs a template per language, so a language without words is not created. |
| 13 | `defineServer` checks the language keys it can see against the declared set and reports each as a `ModulesError` problem: view and screen labels, templates (body, footer, buttons), `channel.does`, the modules' voice eval cases, and keyword names. An undeclared key is a typo or a language the application does not speak. | Task ("views and the registry validation"); existing pattern (one validation pass at boot). |
| 14 | `missingLabels(views, langs)` (`@hykr/ui-registry`, was `emptyLabels`) lists every view title, empty line and noun missing or empty in a language. The sample's views test runs it with its own languages, so its Hindi and Telugu stay complete. | Task ("Keep the sample app on en, hi and te so that nothing it shows changes"). |
| 15 | Evals: each case's language must be declared (decision 13); the WhatsApp suite replays the non-English voice cases; `repliesInLanguage` decides the reply's language from the declared languages' letters: one non-English language with real words and no other's, or English with no other's, else mixed. | Task ("evals"). |
| 16 | `basecamp module add` writes English words only (`{ en: 'Orders' }`), not English copies under each language. Its "Next" list names the application's other languages to translate into, read from the built server's definition when there is one. | Task ("the module scaffold"); default (an English copy under `hi` hides a missing translation from `missingLabels`). |
| 17 | Labels a business types (role labels, `wording.phrases`): any well-formed code is kept when stored settings are read, and the writers refuse a language the application does not declare (`label_language` / phrase problems). | Default: settings never fail to read because a language was dropped; a write is checked. |
| 18 | `app.chat_messages.lang` loses its TypeScript enum (`text('lang')`): the column was already plain text, so there is no migration. | Default. |
| 19 | The sample declares its languages in `application/domain/src/languages.ts` (`@application/domain/languages`): English (`en-GB`, speech `en-IN`), Hindi (`hi-IN`) and Telugu (`te-IN`), with the letter ranges and names the framework had. `application/api/src/server.ts` and `application/mobile/src/app/_layout.tsx` pass it. The sample's per-language tables (`Record<Lang, …>`) become `PerLang` read with `pick`. | Task ("Sample demo: the sample app keeps en, hi and te"). |
| 20 | The fixture declares English, Hindi and Telugu (its WhatsApp, voice and scripted-model tests use them); `features/languages` adds a fixture app that also speaks Greek, which the framework has no phrases for, to prove an application's own language end to end. | Default: a language unlike the sample's (another script, no framework translation). |
| 21 | Removed exports: `LANGS`, `LANG_NAMES`, `LANG_ENGLISH_NAMES`, `DEVANAGARI`, `TELUGU`, `emptyLabels`. Their replacements are `languages().codes`, `languageName`, `englishName`, a language's `letters`, and `missingLabels`. | Plan ("Break APIs freely"). |

## Assumptions to review

| Topic | Choice | Question for the product owner |
|---|---|---|
| Compile-time completeness | Dropped: a missing Hindi word compiles and reads as English; the sample's views test checks its view words. | Should an application be able to opt in to compile-time completeness for its own languages (a typed register of its languages), at the cost of a second declaration? |
| English's default locale | `en-GB` (day-month, 24-hour) for an application that does not set one. | Is `en-GB` the right neutral default, or should English default to plain `en` (US order) and every application choose? |
| Keywords in undeclared languages | The framework's Hindi and Telugu STOP, HELP etc. match in every application. | Should an application that does not speak Hindi still honour a Hindi STOP (safer for consent), as now, or match only its own languages? |
| A language per business | The set is the application's; a business cannot narrow it or pick a default other than English. | Should a business choose which of the application's languages it offers, and its own default? |
| Document fonts | Only the Latin, Devanagari and Telugu Noto fonts are bundled; a declared language in another script renders in documents as missing glyphs. | Should a language declaration name the fonts documents use for it? |
| Speech provider coverage | A declared language's speech tag is passed to the provider as is; nothing checks that the provider supports it. | Should the voice worker refuse (or fall back to English for) a language its provider does not speak? |

## API sketch

```text
@hykr/i18n
  type Lang = string
  type PerLang<T> = { readonly en: T; readonly [lang: string]: T | undefined }
  type Labels = PerLang<string>;  type Noun = PerLang<readonly [one: string, many: string]>
  type LanguageDef = { name; english; locale?; speech?; letters?: RegExp; keywords?: Record<string, string[]> }
  defineLanguages(defs: { en?: Partial<LanguageDef> } & Record<string, LanguageDef>): Languages
  interface Languages { codes; get(code); has(code); scriptOf(text); scriptCounts(text); toWire() }
  setLanguages(set) / languages() / resetLanguages()
  languagesFromWire(wire): Languages
  isLang(v), langOf(tag), pick(table, lang), languageName(lang), englishName(lang),
  localeOf(lang), speechTagOf(lang), scriptOf(text, set?), scriptCounts(text, set?)
  defineMessages({ en, [lang]: Partial<...> })

@hykr/contracts
  Lang (declared code, for inputs), LangCode (shape, for stored values), VoiceLang ('auto' | code),
  LanguagesWire, VoiceDispatch.languages

@hykr/api     defineServer({ ..., languages })      // installed by setRuntime
@hykr/app     <AppShell config={{ ..., languages }}>  // installed by configure()
@hykr/ui-registry   missingLabels(views, langs), languageProblems(views, screens, set)

application/domain/src/languages.ts
  export const languages = defineLanguages({ en: {...}, hi: {...}, te: {...} })
```

## Test plan

- `@hykr/i18n` unit tests: a set with a language the framework has no phrases for (fallback to
  English, the application's override in it), detection order and shared scripts, locales and
  speech tags, the wire round trip, `defineLanguages` refusals, `pick` and `count` fallbacks,
  `defineMessages` with a partial translation.
- `@hykr/voice-worker`: `LangState` with a set from the wire (pinned speech tags, detection
  among the declared languages only).
- `@hykr/channels`: a declared language's keywords; the framework's words still match.
- `@hykr/agents`: the scripted model's pinned language and the scorer with another language.
- `@hykr/ui-registry`: `missingLabels`, `languageProblems`.
- `@hykr/api` unit: `defineServer` refuses undeclared language keys (views, templates,
  `channel.does`, eval cases, keyword names).
- Fixture e2e `languages.e2e.test.ts`: a Greek WhatsApp message is answered with the
  application's Greek phrase (and English where it has none), sticks to the contact, its STOP
  keyword stops; a chat turn in an undeclared language is a 400; a voice session's dispatch
  carries the set and refuses an undeclared language; another business's thread stays a 404.
- The existing suites (voice, WhatsApp golden, templates, views, evals in fake mode) keep
  passing with the sample's declaration.

## Deferred

- Compile-time completeness for an application's own languages (assumption 1).
- Fonts per language in documents (assumption 5).
- A business choosing among the application's languages (assumption 4).
- Translating the framework's phrases into more languages: only the translations it had ship.
