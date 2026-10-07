import { SavedPage, SavedPageSpec } from '@app/contracts';
import { z } from 'zod';
import { action, defineView } from '../define-view.js';
import { count, firstFew } from '../format.js';

const open = action<SavedPage>({ screen: 'page.view', params: (p) => ({ id: p.id }) });

export const PageListView = defineView({
  name: 'page.list',
  description: "The person's saved pages, each opening in the canvas.",
  surfaces: ['inline', 'canvas', 'text', 'voice'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(SavedPage) }),
  source: { entity: SavedPageSpec, into: 'items' },
  actions: { open },
  text: (p) =>
    p.items.length
      ? [p.title ?? 'Your pages', ...p.items.map((x) => `• ${x.name}`)].join('\n')
      : 'No saved pages yet.',
  speak: (p) =>
    p.items.length
      ? `${count(p.items.length, 'saved page')}: ${firstFew(p.items.map((x) => x.name))}.`
      : 'No saved pages yet.',
});
