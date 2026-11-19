import { t } from '@hykr/i18n';
import { z } from 'zod';
import { defineView } from '../define-view.js';
import { checkKpiSource, KPI_TILES, KpiItem, KpiSource, kpiTiles } from './kpi.js';

export const ApprovalCardView = defineView({
  name: 'approval.card',
  description:
    'Something waiting for the person to approve or reject, with exactly what it will do. Shown automatically when a tool is parked.',
  surfaces: ['inline', 'text', 'speech'],
  // `canDecide` false: someone else decides it (a capability's holders, a named person).
  props: z.object({
    approvalId: z.string(),
    summary: z.string().nullable().optional(),
    canDecide: z.boolean().optional(),
  }),
  text: (p, ctx) =>
    t(ctx.lang, p.canDecide === false ? 'said.cardTeam' : 'said.cardWaiting', {
      summary: p.summary ?? t(ctx.lang, 'said.aChange'),
    }),
  speak: (p, ctx) =>
    t(ctx.lang, p.canDecide === false ? 'said.waitingTeam' : 'said.waitingApproval', {
      summary: p.summary ?? t(ctx.lang, 'said.aChange'),
    }),
});

export const KpiRowView = defineView({
  name: 'kpi.row',
  description:
    'Up to four numbers side by side, each with a label ("3 overdue"). Prefer `of`: a summary of an entity ({ entity: "<plural>", query: { <filters>, groupBy, sum, … } }), computed for whoever sees it, also on a saved page. Use `items` only for numbers you already have.',
  // In the chat too: the summarize tool shows its counts as tiles.
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z
    .object({
      /** Numbers the assistant already has. */
      items: z.array(KpiItem).min(1).max(KPI_TILES).optional(),
      /** Or: tiles from a summary, computed with the reader's session wherever they are shown. */
      of: KpiSource.optional(),
    })
    .refine((p) => (p.items === undefined) !== (p.of === undefined), {
      message: 'Give either items (numbers you have) or of (a summary to compute)',
    }),
  check: (p, ctx) => (p.of ? checkKpiSource(p.of, ctx) : null),
  // In words (WhatsApp, voice): the summary is fetched as the reader, then shown as tiles.
  load: async (p, io) =>
    p.of
      ? {
          items: kpiTiles(await io.summary(p.of.entity, p.of.query), p.of, {
            spec: io.entity(p.of.entity),
            lang: io.lang,
          }),
        }
      : p,
  text: (p) => (p.items ?? []).map((k) => `${k.label}: ${k.value}`).join('\n'),
  speak: (p) => (p.items ?? []).map((k) => `${k.value} ${k.label}`).join(', '),
});
