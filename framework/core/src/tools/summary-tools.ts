import {
  type EntitySpec,
  SUMMARY_FNS,
  type Summary,
  summarizable,
  summaryInputObject,
} from '@hykr/contracts';
import { createTool } from '@mastra/core/tools';
import { safely, type ToolKit } from './tool-factory.js';

/** At most this many tiles in a `kpi.row`. */
const KPI_TILES = 4;

/** How many tiles a summary makes: its groups, or its totals' count and measures. */
function tileCount(summary: Summary, measures: number): number {
  if (summary.groups.length) return summary.more ? KPI_TILES + 1 : summary.groups.length;
  return summary.totals.length * (1 + measures);
}

/**
 * `summarize-<plural>`: counts and totals of an entity's records, grouped or not, through
 * `GET /api/<plural>/summary` (the list's scope and filters; hidden fields refused). A result
 * that fits in a `kpi.row` shows as one with `of`: the row computes its numbers again wherever it
 * is shown, so they are never the model's.
 */
export function summaryTools(spec: EntitySpec, kit: ToolKit) {
  if (spec.expose.list !== 'all') return {};
  const { plural, label } = spec;
  const { group, measure } = summarizable(spec);
  const id = `summarize-${plural}`;
  const groups = group.map((g) =>
    g.by === 'bucket' ? `${g.field}:<day|week|month|quarter|year>` : g.field,
  );
  const parts = [
    `Counts and totals of ${label}s (numbers, not a written summary of their text): how many, and the sum, average, lowest or highest of a field, for all of them or per group.`,
    groups.length ? ` "groupBy": up to 2 of ${groups.join(', ')}.` : ' It cannot group.',
    measure.length
      ? ` "sum", "avg", "min", "max": lists of ${measure.map((m) => `${m.field} (${m.as === 'money' ? 'money, per currency' : 'number'})`).join(', ')}.`
      : ' Only counts.',
    ` Filters are the same as list-${plural}'s. "sort": count, key or sum:<field>, "-" first for descending; "limit": how many groups.`,
    ' When the answer fits, it is shown to the user as number tiles; say one line about it.',
  ];
  return {
    [id]: createTool({
      id,
      description: parts.join(''),
      inputSchema: summaryInputObject(spec),
      execute: async (input, ctx) =>
        safely(
          id,
          ctx,
          kit,
          () =>
            kit
              .clientFor(ctx)
              .entity(spec)
              .summary(input as Record<string, unknown>),
          (summary) => {
            const q = input as Record<string, unknown>;
            const count = (v: unknown) =>
              Array.isArray(v) ? v.length : typeof v === 'string' ? v.split(',').length : 0;
            const measures = SUMMARY_FNS.reduce((n, fn) => n + count(q[fn]), 0);
            const fits = tileCount(summary, measures) <= KPI_TILES;
            return fits && kit.registry.getViewDef('kpi.row')
              ? { kind: 'inline', view: 'kpi.row', props: { of: { entity: plural, query: q } } }
              : undefined;
          },
        ),
    }),
  };
}
