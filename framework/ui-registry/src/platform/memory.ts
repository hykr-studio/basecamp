import { Memory, MemorySpec } from '@hykr/contracts';
import { pick } from '@hykr/i18n';
import { z } from 'zod';
import { defineView, spokenList, type ViewLabels } from '../define-view.js';

const labels = {
  title: { en: 'What the business remembers', hi: 'व्यवसाय की यादें', te: 'వ్యాపారం గుర్తుంచుకున్నవి' },
  empty: {
    en: 'Nothing remembered yet.',
    hi: 'अभी कुछ याद नहीं रखा गया है।',
    te: 'ఇంకా ఏదీ గుర్తుంచుకోలేదు.',
  },
  noun: {
    en: ['memory', 'memories'],
    hi: ['याद', 'यादें'],
    te: ['జ్ఞాపకం', 'జ్ఞాపకాలు'],
  },
} satisfies ViewLabels;

const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** The business's memories: facts every member's assistant may recall. */
export const MemoryListView = defineView({
  name: 'memory.list',
  description:
    "The business's memories (list-memories): lasting facts everyone in the business shares. Not for one record's notes, and not for recall results.",
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().max(60).optional(), items: z.array(Memory) }),
  source: { entity: MemorySpec, into: 'items' },
  labels,
  text: (p, ctx) =>
    p.items.length
      ? [
          p.title ?? pick(labels.title, ctx.lang),
          ...p.items.map((m) => `• ${short(m.text, 160)}`),
        ].join('\n')
      : pick(labels.empty, ctx.lang),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((m) => short(m.text, 60)),
      labels,
      ctx,
    ),
});
