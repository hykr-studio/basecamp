import { NoteSpec, NoteView } from '@app/contracts';
import { pick } from '@app/i18n';
import { z } from 'zod';
import { action, defineView, spokenList, type ViewLabels } from '../define-view.js';

const open = action<NoteView>({ screen: 'note.detail', params: (n) => ({ id: n.id }) });
const excerpt = (body: string, n: number) =>
  body.length > n ? `${body.slice(0, n).trimEnd()}…` : body;

const labels = {
  title: { en: 'Notes', hi: 'नोट', te: 'నోట్‌లు' },
  empty: { en: 'No notes.', hi: 'कोई नोट नहीं।', te: 'నోట్‌లు ఏవీ లేవు.' },
  noun: { en: ['note', 'notes'], hi: ['नोट', 'नोट'], te: ['నోట్', 'నోట్‌లు'] },
} satisfies ViewLabels;

export const NoteCardView = defineView({
  name: 'note.card',
  description: 'One note: its title and body.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ id: z.string(), item: NoteView }),
  source: { entity: NoteSpec, into: 'item', by: 'id' },
  actions: { open },
  labels: { noun: labels.noun },
  text: (p) => [p.item.title, excerpt(p.item.body, 600)].filter(Boolean).join('\n'),
  speak: (p) => `${p.item.title}. ${excerpt(p.item.body, 160)}`,
});

export const NoteListView = defineView({
  name: 'note.list',
  description:
    'A list of notes with the start of each body. Use for "my notes", or notes matching a search.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(NoteView) }),
  source: { entity: NoteSpec, into: 'items' },
  actions: { open },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((n) => `• ${n.title}${n.body ? `: ${excerpt(n.body, 80)}` : ''}`)]
          .filter(Boolean)
          .join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((n) => n.title),
      labels,
      ctx,
    ),
});
