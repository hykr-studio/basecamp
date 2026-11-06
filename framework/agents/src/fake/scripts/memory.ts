// Memory:
//   remember (that) <fact>              create-memory: the business remembers it
//   what do you remember about <x>      recall-memory, then the best match
//   recall <x>
import { call, defineScript, type Outcome, say, sayIn, written } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

type Recalled = { items?: { kind: string; text: string }[] };

/** The best record that is memory, else the best thing the person said. */
const best = (o: Outcome) => {
  const items = (o.result as Recalled | undefined)?.items ?? [];
  return items.find((i) => i.kind === 'record') ?? items[0];
};

export const memoryScripts = defineScriptSet({
  name: 'memory',
  order: 300,
  scripts: [
    defineScript({
      name: 'remember',
      match: (text) => /^(?:please )?remember(?: that|:)? (.+?)\.?$/i.exec(text)?.[1],
      step: (fact, turn) => {
        const r = turn.result('create-memory');
        if (!r) return [call('create-memory', { text: fact })];
        if (!r.ok) return [say("I couldn't remember that.")];
        return [
          say(
            written(
              r,
              () =>
                ({
                  en: "I'll remember that.",
                  hi: 'मैं यह याद रखूँगा।',
                  te: 'నేను దీన్ని గుర్తుంచుకుంటాను.',
                })[turn.lang],
              turn,
            ),
          ),
        ];
      },
    }),
    defineScript({
      name: 'recall',
      match: (text) =>
        /^(?:what do you (?:remember|know) about|recall) (.+?)\??$/i.exec(text.trim())?.[1],
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
        return [say(`I remember: ${found.text}`)];
      },
    }),
  ],
});
