import { call, defineScript, type Outcome, say, sayIn, verbs, written } from '@hykr/agents/script';
import { pick } from '@hykr/i18n';

/**
 * The scripted model's knowledge of the notes module (tests, CI and demos without a key):
 *   note <title>, with a photo sent on WhatsApp     create-note with the photo on it
 *   <x> के बारे में क्या याद है?                      recall-memory, then the best match, in Hindi
 *   <x> గురించి ఏమి గుర్తుంది?                        the same, in Telugu
 *
 * A photo sent on WhatsApp reaches the turn as a line naming its file id (the files feature's
 * inbound hook); the caption says what to do with it. "What do you remember about <x>" in
 * English is the framework's own memory script.
 */
const FILE_ID = /file id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** "<x> के बारे में क्या याद है?", "<x> గురించి ఏమి గుర్తుంది?": what the business remembers. */
const RECALL = new RegExp(
  `^(.+?)\\s+(?:${verbs('के बारे में क्या याद है', 'గురించి ఏమి గుర్తుంది', 'గురించి ఏం గుర్తుంది')})\\s*\\??$`,
  'iu',
);

type Recalled = { items?: { kind: string; text: string }[] };

/** The best record that is memory (a note), else the best thing the person said. */
const best = (o: Outcome) => {
  const found = (o.result as Recalled | undefined)?.items ?? [];
  return found.find((i) => i.kind === 'record') ?? found[0];
};

export const notesScripts = [
  defineScript({
    name: 'note-with-photos',
    match: (text) => {
      const title = /^note:?\s+(.+)$/im.exec(text.split('\n')[0] ?? '')?.[1]?.trim();
      const photos = [...text.matchAll(FILE_ID)].map((m) => m[1]);
      return title && photos.length ? { title, photos } : undefined;
    },
    step: ({ title, photos }, turn) => {
      const r = turn.result('create-note');
      if (!r) return [call('create-note', { title, photos })];
      const kept = (n: { title: string }) =>
        pick(
          {
            en: `Saved the photo on the note "${n.title}".`,
            hi: `फ़ोटो नोट "${n.title}" में सहेज दी।`,
            te: `ఫోటోను "${n.title}" నోట్‌లో సేవ్ చేశాను.`,
          },
          turn.lang,
        );
      return [say(written(r, kept, turn))];
    },
  }),
  defineScript({
    name: 'recall-in-words',
    match: (text) => RECALL.exec(text.split('\n')[0]?.trim() ?? '')?.[1],
    step: (query, turn) => {
      const r = turn.result('recall-memory');
      if (!r) return [call('recall-memory', { query })];
      const found = r.ok ? best(r) : undefined;
      if (!found)
        return [
          sayIn(turn, {
            en: "I don't remember anything about that.",
            hi: 'मुझे इसके बारे में कुछ याद नहीं है।',
            te: 'దాని గురించి నాకు ఏమీ గుర్తు లేదు.',
          }),
        ];
      // What was noted is data, as it was written; the words around it are the turn's.
      const lead = pick({ en: 'I remember:', hi: 'मुझे याद है:', te: 'నాకు గుర్తుంది:' }, turn.lang);
      return [say(`${lead} ${found.text}`)];
    },
  }),
];
