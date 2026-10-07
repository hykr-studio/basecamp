import { z } from 'zod';
import { defineView } from '../define-view.js';

export const ApprovalCardView = defineView({
  name: 'approval.card',
  description:
    'Something waiting for the person to approve or reject, with exactly what it will do. Shown automatically when a tool is parked.',
  surfaces: ['inline', 'text', 'voice'],
  props: z.object({ approvalId: z.string(), summary: z.string().nullable().optional() }),
  text: (p) =>
    `Waiting for your approval: ${p.summary ?? 'a change'}. Approve or reject it in the app.`,
  speak: (p) => `${p.summary ?? 'A change'} is waiting for your approval in the app.`,
});

export const KpiRowView = defineView({
  name: 'kpi.row',
  description:
    'Up to four numbers side by side, each with a label ("3 overdue"). Use only for counts you already have; the props carry the numbers.',
  surfaces: ['canvas', 'text', 'voice'],
  props: z.object({
    items: z
      .array(
        z.object({
          label: z.string().max(40),
          value: z.union([z.number(), z.string().max(20)]),
          hint: z.string().max(60).optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  text: (p) => p.items.map((k) => `${k.label}: ${k.value}`).join('\n'),
  speak: (p) => p.items.map((k) => `${k.value} ${k.label}`).join(', '),
});
