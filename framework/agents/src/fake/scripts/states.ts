// State machines (any entity with states):
//   apply <transition> to <plural> "<title>"   list-<plural> → transition-<plural> (may wait)
// A refused move (a wrong state, a missing capability) is answered by the engine itself.
import { call, defineScript, items, type Row, say, sameTitle, written } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

const APPLY = /^apply ([a-z][\w-]*) to ([a-z][\w-]*) ["“](.+?)["”]\.?$/i;

export const statesScripts = defineScriptSet({
  name: 'states',
  order: 400,
  scripts: [
    defineScript({
      name: 'apply-transition',
      match: (text) => {
        const m = APPLY.exec(text.trim());
        return m ? { transition: m[1], plural: m[2], title: m[3] } : undefined;
      },
      step: ({ transition, plural, title }, turn) => {
        const moved = turn.result(`transition-${plural}`);
        if (moved) return [say(written(moved, () => `Done: "${title}" took "${transition}".`, turn))];
        const found = turn.result(`list-${plural}`);
        if (!found) return [call(`list-${plural}`, { q: title })];
        const record = items(found).find((r: Row) => sameTitle(String(r.title ?? ''), title));
        // Never an invented id: nothing by that title, no move.
        if (!record) return [say(`I couldn't find "${title}".`)];
        return [call(`transition-${plural}`, { id: record.id, transition })];
      },
    }),
  ],
});
