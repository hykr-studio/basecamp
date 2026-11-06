// Files:
//   what does file <id> say            transcribe-file (an audio file's words)
//   what is file <id>                  get-file (its name, type and the record it is on)
//   <only a file sent on WhatsApp>     asks which record it should go on
import { call, defineScript, say } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

// A refused call (another business's file: 404) is answered by the engine itself.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

export const filesScripts = defineScriptSet({
  name: 'files',
  order: 300,
  scripts: [
    defineScript({
      name: 'file-words',
      match: (text) => new RegExp(`^what does file ${UUID} say\\??$`, 'i').exec(text.trim())?.[1],
      step: (id, turn) => {
        const r = turn.result('transcribe-file');
        if (!r) return [call('transcribe-file', { id })];
        const { text } = r.result as { text: string };
        return [say(text ? `The file says: "${text}"` : 'There are no words in that file.')];
      },
    }),
    defineScript({
      name: 'file-about',
      match: (text) => new RegExp(`^what is file ${UUID}\\??$`, 'i').exec(text.trim())?.[1],
      step: (id, turn) => {
        const r = turn.result('get-file');
        if (!r) return [call('get-file', { id })];
        const f = r.result as {
          name: string;
          mime: string;
          attachedTo: { entity: string } | null;
        };
        const where = f.attachedTo ? `on a ${f.attachedTo.entity}` : 'not on any record yet';
        return [say(`"${f.name}" is a ${f.mime} file, ${where}.`)];
      },
    }),
    // A file and nothing else: the hook's line starts the message.
    defineScript({
      name: 'file-only',
      match: (text) => /^A file came with this message: "([^"]*)"/.exec(text.trim())?.[1],
      step: (name) => [say(`I have your file "${name}". Which record should it go on?`)],
    }),
  ],
});
