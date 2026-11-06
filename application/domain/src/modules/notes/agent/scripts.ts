import { call, defineScript, say, written } from '@hykr/agents/script';

/**
 * The scripted model's knowledge of the notes module (tests, CI and demos without a key):
 *   note <title>, with a photo sent on WhatsApp     create-note with the photo on it
 *
 * A photo sent on WhatsApp reaches the turn as a line naming its file id (the files feature's
 * inbound hook); the caption says what to do with it.
 */
const FILE_ID = /file id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

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
        ({
          en: `Saved the photo on the note "${n.title}".`,
          hi: `फ़ोटो नोट "${n.title}" में सहेज दी।`,
          te: `ఫోటోను "${n.title}" నోట్‌లో సేవ్ చేశాను.`,
        })[turn.lang];
      return [say(written(r, kept, turn))];
    },
  }),
];
