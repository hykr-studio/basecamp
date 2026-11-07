// Documents:
//   is document <id> ready?            get-document (its state, its file and its sends)
import { call, defineScript, say } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

// A refused call (another business's document: 404) is answered by the engine itself.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

export const documentsScripts = defineScriptSet({
  name: 'documents',
  order: 310,
  scripts: [
    defineScript({
      name: 'document-status',
      match: (text) => new RegExp(`^is document ${UUID} ready\\??$`, 'i').exec(text.trim())?.[1],
      step: (id, turn) => {
        const r = turn.result('get-document');
        if (!r) return [call('get-document', { id })];
        const d = r.result as {
          name: string;
          status: 'pending' | 'ready' | 'failed';
          pages: number | null;
          sends?: { status: string }[];
        };
        if (d.status === 'pending') return [say(`"${d.name}" is still being made.`)];
        if (d.status === 'failed') return [say(`"${d.name}" could not be made.`)];
        const sent = (d.sends ?? []).filter((s) => s.status === 'sent').length;
        return [
          say(
            `"${d.name}" is ready: ${d.pages} page${d.pages === 1 ? '' : 's'}${sent ? `, sent ${sent} time${sent === 1 ? '' : 's'}` : ''}.`,
          ),
        ];
      },
    }),
  ],
});
