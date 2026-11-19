// Share links (decisions B23):
//   send the <entity> <id> link to its customer     create-share-link (waits for approval)
//   send link <id> again                            send-share-link (a new link in its place)
// The assistant never sees a link's token or address: it says what will be sent, to whom.
import { call, defineScript, say, written } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

type Drafted = { message?: string };

export const shareScripts = defineScriptSet({
  name: 'share',
  order: 315,
  scripts: [
    defineScript({
      name: 'share-send-link',
      match: (text) => {
        const m = new RegExp(
          `^send the ([a-z][a-zA-Z0-9]*) ${UUID} link to its customer\\.?$`,
          'i',
        ).exec(text.trim());
        return m ? { entity: m[1], id: m[2] } : undefined;
      },
      step: ({ entity, id }, turn) => {
        const r = turn.result('create-share-link');
        if (!r)
          return [
            call('create-share-link', { target: { entity, id }, to: { recordCustomer: true } }),
          ];
        if (!r.ok) return [say('I could not send that link.')];
        return [say(written(r, (v) => (v as Drafted).message ?? 'The link is on its way.', turn))];
      },
    }),
    defineScript({
      name: 'share-send-again',
      match: (text) => new RegExp(`^send link ${UUID} again\\.?$`, 'i').exec(text.trim())?.[1],
      step: (linkId, turn) => {
        const r = turn.result('send-share-link');
        if (!r) return [call('send-share-link', { linkId })];
        if (!r.ok) return [say('I could not send that link again.')];
        return [
          say(written(r, (v) => (v as Drafted).message ?? 'A new link is on its way.', turn)),
        ];
      },
    }),
  ],
});
