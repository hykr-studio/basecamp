// For tests of what happens when a turn fails:
//   FAIL THIS TURN               the model errors
import { defineScript } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

export const testingScripts = defineScriptSet({
  name: 'testing',
  order: 900,
  scripts: [
    defineScript({
      name: 'fail',
      match: (text) => (/^FAIL THIS TURN$/.test(text.trim()) ? true : undefined),
      step: () => {
        throw new Error('Scripted failure');
      },
    }),
  ],
});
