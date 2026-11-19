// Files:
//   what does file <id> say            transcribe-file (an audio file's words)
//   what is file <id>                  get-file (its name, type and the record it is on)
//   read file <id> [pages 1,2] [: q]   read-file (what a photo or PDF shows)
//   what does this say / read this     read-file on the file that came with the message
//   <only a file sent on WhatsApp>     asks which record it should go on
import { call, defineScript, say } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

// A refused call (another business's file: 404) is answered by the engine itself.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/** The id in a file line ("A file came with this message: … file id <id>."). */
export const fileLineId = (text: string) =>
  new RegExp(`A file came with this message: .*?file id ${UUID}`).exec(text)?.[1];

type Read = { id: string; pages?: number[]; question?: string };

const readStep = (args: Read, turn: { result(tool: string): { result?: unknown } | undefined }) => {
  const r = turn.result('read-file');
  if (!r)
    return [
      call('read-file', {
        id: args.id,
        ...(args.pages ? { pages: args.pages } : {}),
        ...(args.question ? { question: args.question } : {}),
      }),
    ];
  const { text, pages } = r.result as { text: string; pages: number };
  const seen = pages > 1 ? ` (${pages} pages)` : '';
  return [say(text ? `The file shows${seen}: ${text}` : 'I could not make out anything in it.')];
};

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
    defineScript({
      name: 'file-read',
      match: (text): Read | undefined => {
        const m = new RegExp(
          `^read file ${UUID}(?: pages ([0-9, ]+))?(?:\\s*:\\s*(.+))?$`,
          'is',
        ).exec(text.trim());
        if (!m) return undefined;
        const pages = m[2]
          ?.split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        return {
          id: m[1],
          ...(pages?.length ? { pages } : {}),
          ...(m[3] ? { question: m[3].trim() } : {}),
        };
      },
      step: readStep,
    }),
    // "What does this say?" with a file sent on WhatsApp: read the file that came with it.
    defineScript({
      name: 'file-read-sent',
      match: (text): Read | undefined => {
        const first = text.trim().split('\n')[0] ?? '';
        if (
          !/^(what does (this|it) say|read (this|it)|what is in (this|it)|what does (this|it) show)\b/i.test(
            first,
          )
        )
          return undefined;
        const id = fileLineId(text);
        return id ? { id } : undefined;
      },
      step: readStep,
    }),
    // A file and nothing else: the hook's line starts the message.
    defineScript({
      name: 'file-only',
      match: (text) => /^A file came with this message: "([^"]*)"/.exec(text.trim())?.[1],
      step: (name) => [say(`I have your file "${name}". Which record should it go on?`)],
    }),
  ],
});
