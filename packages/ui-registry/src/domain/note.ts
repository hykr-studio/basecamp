import { NoteSpec, NoteView } from '@app/contracts';
import { z } from 'zod';
import { action, defineView } from '../define-view.js';
import { count, firstFew } from '../format.js';

const open = action<NoteView>({ screen: 'note.detail', params: (n) => ({ id: n.id }) });
const excerpt = (body: string, n: number) =>
  body.length > n ? `${body.slice(0, n).trimEnd()}…` : body;

export const NoteCardView = defineView({
  name: 'note.card',
  description: 'One note: its title and body.',
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ id: z.string(), item: NoteView }),
  source: { entity: NoteSpec, into: 'item', by: 'id' },
  actions: { open },
  text: (p) => [p.item.title, excerpt(p.item.body, 600)].filter(Boolean).join('\n'),
  speak: (p) => `${p.item.title}. ${excerpt(p.item.body, 160)}`,
});

export const NoteListView = defineView({
  name: 'note.list',
  description:
    'A list of notes with the start of each body. Use for "my notes", or notes matching a search.',
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(NoteView) }),
  source: { entity: NoteSpec, into: 'items' },
  actions: { open },
  text: (p) =>
    p.items.length
      ? [p.title, ...p.items.map((n) => `• ${n.title}${n.body ? `: ${excerpt(n.body, 80)}` : ''}`)]
          .filter(Boolean)
          .join('\n')
      : 'No notes.',
  speak: (p) =>
    p.items.length
      ? `${count(p.items.length, 'note')}: ${firstFew(p.items.map((n) => n.title))}.`
      : 'No notes.',
});
