/**
 * Words people send that code handles, never the agent: stopping and restarting messages,
 * help, asking for a person, erasing their data, linking their account. In English, Hindi and
 * Telugu, any case, with or without punctuation.
 */
export type Keyword =
  | 'stop'
  | 'stop_reminders'
  | 'start'
  | 'help'
  | 'human'
  | 'delete_my_data'
  | 'link_account';

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

const TABLE = new Map<string, Keyword>(
  (Object.entries(WORDS) as [Keyword, string[]][]).flatMap(([k, words]) =>
    words.map((w) => [normal(w), k] as const),
  ),
);

/** The keyword a whole message is, if it is one (a sentence that mentions one is not). */
export function keywordOf(text: string): Keyword | undefined {
  return TABLE.get(normal(text));
}
