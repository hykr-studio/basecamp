import { type Lang, moneyText, pick } from '@hykr/i18n';
import { defineView, spokenList, type ViewLabels } from '@hykr/ui-registry';
import { z } from 'zod';
import { BriefSpec, BriefView } from '../contracts/index.js';

const labels = {
  title: { en: 'Briefs', hi: 'ब्रीफ़', te: 'బ్రీఫ్‌లు' },
  empty: { en: 'No briefs.', hi: 'कोई ब्रीफ़ नहीं।', te: 'బ్రీఫ్‌లు ఏవీ లేవు.' },
  noun: {
    en: ['brief', 'briefs'],
    hi: ['ब्रीफ़', 'ब्रीफ़'],
    te: ['బ్రీఫ్', 'బ్రీఫ్‌లు'],
  },
} satisfies ViewLabels;

/** "Asha: a new kitchen shelf (about €500)". */
const line = (b: BriefView, lang: Lang) =>
  `${b.name}: ${b.summary.slice(0, 80)}${b.budget ? ` (${moneyText(b.budget, lang)})` : ''}`;

export const BriefListView = defineView({
  name: 'brief.list',
  description: 'A list of briefs, newest first: who, what they need, and their rough budget.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(BriefView) }),
  source: { entity: BriefSpec, into: 'items' },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [p.title, ...p.items.map((x) => `• ${line(x, ctx.lang)}`)].filter(Boolean).join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((x) => x.name),
      labels,
      ctx,
    ),
});
