import { SavedPage, SavedPageSpec } from '@app/contracts';
import { pick } from '@app/i18n';
import { z } from 'zod';
import { action, defineView, spokenList, type ViewLabels } from '../define-view.js';

const open = action<SavedPage>({ screen: 'page.view', params: (p) => ({ id: p.id }) });

const labels = {
  title: { en: 'Your pages', hi: 'आपके पेज', te: 'మీ పేజీలు' },
  empty: {
    en: 'No saved pages yet.',
    hi: 'अभी कोई सेव किया पेज नहीं।',
    te: 'ఇంకా సేవ్ చేసిన పేజీలు లేవు.',
  },
  noun: {
    en: ['saved page', 'saved pages'],
    hi: ['सेव किया पेज', 'सेव किए पेज'],
    te: ['సేవ్ చేసిన పేజీ', 'సేవ్ చేసిన పేజీలు'],
  },
} satisfies ViewLabels;

export const PageListView = defineView({
  name: 'page.list',
  description: "The person's saved pages, each opening in the canvas.",
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(SavedPage) }),
  source: { entity: SavedPageSpec, into: 'items' },
  actions: { open },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title ?? pick(labels.title, ctx.lang), ...p.items.map((x) => `• ${x.name}`)].join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((x) => x.name),
      labels,
      ctx,
    ),
});
