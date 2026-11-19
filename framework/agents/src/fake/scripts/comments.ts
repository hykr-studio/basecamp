// Comments:
//   comments on <entity> <id>              list-comments (how many, and the latest)
//   comment on <entity> <id>: <text>       add-comment (it may wait for approval)
//   who can I mention on <entity> <id>     list-mentionable
import { type Comment, type Mention, plainComment } from '@hykr/contracts';
import { call, defineScript, plural, say, written } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

// A refused call (a record they cannot read: 404) is answered by the engine itself.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ENTITY = '([a-zA-Z][a-zA-Z0-9]*)';

export const commentsScripts = defineScriptSet({
  name: 'comments',
  order: 320,
  scripts: [
    defineScript({
      name: 'comments-list',
      match: (text) => {
        const m = new RegExp(`^comments on ${ENTITY} ${UUID}\\??$`, 'i').exec(text.trim());
        return m ? { entity: m[1], id: m[2] } : undefined;
      },
      step: ({ entity, id }, turn) => {
        const r = turn.result('list-comments');
        if (!r) return [call('list-comments', { entity, id })];
        const { items } = r.result as { items: Comment[] };
        if (!items.length) return [say(`There are no comments on that ${entity} yet.`)];
        const [latest] = items;
        const who = latest.author.name ?? 'Someone';
        return [
          say(
            `${plural(items.length, 'comment')}. The latest, from ${who}: "${plainComment(latest.body)}"`,
          ),
        ];
      },
    }),
    defineScript({
      name: 'comments-add',
      match: (text) => {
        const m = new RegExp(`^comment on ${ENTITY} ${UUID}: (.+)$`, 'is').exec(text.trim());
        return m ? { entity: m[1], recordId: m[2], body: m[3].trim() } : undefined;
      },
      step: (input, turn) => {
        const r = turn.result('add-comment');
        if (!r) return [call('add-comment', input)];
        return [say(written(r, () => 'Added your comment.', turn))];
      },
    }),
    defineScript({
      name: 'comments-mentionable',
      match: (text) => {
        const m = new RegExp(`^who can I mention on ${ENTITY} ${UUID}\\??$`, 'i').exec(text.trim());
        return m ? { entity: m[1], id: m[2] } : undefined;
      },
      step: ({ entity, id }, turn) => {
        const r = turn.result('list-mentionable');
        if (!r) return [call('list-mentionable', { entity, id })];
        const { items } = r.result as { items: Mention[] };
        if (!items.length) return [say(`Nobody else can see that ${entity}.`)];
        return [say(`You can mention ${items.map((m) => m.label).join(', ')}.`)];
      },
    }),
  ],
});
