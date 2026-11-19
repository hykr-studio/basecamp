import { type Languages, languages } from '@hykr/i18n';

/**
 * Words people send that code handles, never the agent: stopping and restarting messages,
 * help, asking for a person, erasing their data, linking their account. Any case, with or
 * without punctuation. The framework knows them in English and in the translations it ships,
 * and always matches those (a STOP is never missed); each of the application's languages adds
 * its own (`keywords` in `defineLanguages`).
 */
export const KEYWORDS = [
  'stop',
  'stop_reminders',
  'start',
  'help',
  'human',
  'delete_my_data',
  'link_account',
] as const;
export type Keyword = (typeof KEYWORDS)[number];

const WORDS: Record<Keyword, string[]> = {
  stop: ['stop', 'unsubscribe', 'रोकें', 'बंद करो', 'रोको', 'ఆపు', 'ఆపండి'],
  stop_reminders: ['stop reminders', 'रिमाइंडर बंद', 'రిమైండర్లు ఆపు'],
  start: ['start', 'subscribe', 'शुरू', 'शुरू करो', 'ప్రారంభించు', 'మొదలు'],
  help: ['help', 'मदद', 'सहायता', 'సహాయం'],
  human: [
    'talk to a person',
    'talk to a human',
    'agent',
    'human',
    'किसी इंसान से बात',
    'इंसान से बात करनी है',
    'మనిషితో మాట్లాడాలి',
    'మనిషి',
  ],
  delete_my_data: ['delete my data', 'erase my data', 'मेरा डेटा हटाओ', 'నా డేటా తొలగించు'],
  link_account: ['link my account', 'link account', 'खाता जोड़ो', 'ఖాతా లింక్ చేయి'],
};

const normal = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.!?।,]+/g, ' ')
    .trim();

const isKeyword = (k: string): k is Keyword => (KEYWORDS as readonly string[]).includes(k);

const table = (set: Languages) =>
  new Map<string, Keyword>([
    ...(Object.entries(WORDS) as [Keyword, string[]][]).flatMap(([k, words]) =>
      words.map((w) => [normal(w), k] as const),
    ),
    ...set.list.flatMap((l) =>
      Object.entries(l.keywords)
        .filter(([k]) => isKeyword(k))
        .flatMap(([k, words]) => words.map((w) => [normal(w), k as Keyword] as const)),
    ),
  ]);
let built: { set: Languages; table: Map<string, Keyword> } | undefined;

/** The keyword a whole message is, if it is one (a sentence that mentions one is not). */
export function keywordOf(text: string): Keyword | undefined {
  const set = languages();
  if (built?.set !== set) built = { set, table: table(set) };
  return built.table.get(normal(text));
}

/** A language's keywords that name no keyword: what `defineServer` refuses. */
export function keywordProblems(set: Languages): string[] {
  return set.list.flatMap((l) =>
    Object.keys(l.keywords)
      .filter((k) => !isKeyword(k))
      .map(
        (k) =>
          `The language ${l.code} has words for "${k}", which is not a keyword (${KEYWORDS.join(', ')})`,
      ),
  );
}
