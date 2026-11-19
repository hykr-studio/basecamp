import {
  type EntitySpec,
  type Money,
  measureKey,
  SUMMARY_FNS,
  type Summary,
  type SummaryBucket,
  type SummaryFn,
  type SummaryValue,
  summaryInputSchema,
  ViewQuery,
} from '@hykr/contracts';
import { dayText, type Lang, localeOf, moneyText, pick, t } from '@hykr/i18n';
import { z } from 'zod';
import type { ViewCheckContext } from '../define-view.js';

/** One number tile: what it counts, the number (or its text), and a line under it. */
export const KpiItem = z.object({
  label: z.string().max(40),
  value: z.union([z.number(), z.string().max(40)]),
  hint: z.string().max(60).optional(),
});
export type KpiItem = z.infer<typeof KpiItem>;

/**
 * Tiles from a summary, computed wherever the row is shown with the reader's own session: an
 * entity (by plural), its summary query (the list's filters, groupBy, sum, avg, min, max, sort,
 * limit), and labels for tiles by key (`open`, `2026-11`) or measure (`count`, `sum:total`).
 */
export const KpiSource = z.object({
  entity: z.string().min(1).max(60),
  query: ViewQuery.default({}),
  labels: z.record(z.string().max(100), z.string().max(40)).optional(),
});
export type KpiSource = z.infer<typeof KpiSource>;

/** At most this many tiles in a row. */
export const KPI_TILES = 4;

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === 'string'
      ? v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

/** `of` checked against its entity's summary grammar, when the registry knows the entity. */
export function checkKpiSource(of: KpiSource, ctx: ViewCheckContext): string | null {
  if (!ctx.entity) return null;
  const spec = ctx.entity(of.entity);
  if (!spec) return `of: no entity called ${of.entity}`;
  if (spec.expose.list === 'internal') return `of: ${of.entity} cannot be summarized`;
  const r = summaryInputSchema(spec).safeParse(of.query);
  return r.success ? null : `of.query: ${z.prettifyError(r.error).replaceAll('\n', ' ')}`;
}

const isMoney = (v: SummaryValue): v is Money => v !== null && typeof v === 'object';

function valueText(v: SummaryValue | undefined, lang: Lang): string | number {
  if (v === null || v === undefined) return '—';
  if (isMoney(v)) return moneyText(v, lang);
  return Number.isInteger(v)
    ? v
    : new Intl.NumberFormat(localeOf(lang), { maximumFractionDigits: 2 }).format(v);
}

function fieldLabel(spec: EntitySpec | undefined, field: string, lang: Lang): string {
  const labels = spec?.fieldLabels?.[field];
  return labels ? pick(labels, lang) : field;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A group's key value in words: a month as "Nov 2026", a day as a date, true/false, none. */
function keyText(value: string | boolean | null, bucket: string | undefined, lang: Lang): string {
  if (value === null) return t(lang, 'summary.none');
  if (typeof value === 'boolean') return t(lang, value ? 'summary.yes' : 'summary.no');
  if ((bucket === 'day' || bucket === 'week') && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return dayText(value, lang);
  if (bucket === 'month' && /^\d{4}-\d{2}$/.test(value))
    return new Intl.DateTimeFormat(localeOf(lang), {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${value}-01T00:00:00Z`));
  return value;
}

/**
 * A summary's tiles, at most four. With groups: one tile per group, labelled by its key, its
 * value the first measure asked for (else the count). Without: the count, then each measure,
 * per currency when it measures money.
 */
export function kpiTiles(
  summary: Summary,
  of: KpiSource,
  o: { spec?: EntitySpec; lang: Lang },
): KpiItem[] {
  const { lang, spec } = o;
  const q = of.query as Record<string, unknown>;
  const groupBy = list(q.groupBy).map((token) => token.split(':') as [string, string?]);
  const measures: { fn: SummaryFn; field: string }[] = SUMMARY_FNS.flatMap((fn) =>
    list(q[fn]).map((field) => ({ fn, field })),
  );
  const label = (key: string, fallback: () => string) => clip(of.labels?.[key] ?? fallback(), 40);
  const measureLabel = (m: { fn: SummaryFn; field: string }) =>
    label(measureKey(m), () =>
      t(lang, `summary.${m.fn}`, { field: fieldLabel(spec, m.field, lang) }),
    );
  const countLabel = () => label('count', () => t(lang, 'summary.count'));
  const read = (b: SummaryBucket, m: { fn: SummaryFn; field: string }) => b[m.fn]?.[m.field];

  if (groupBy.length) {
    if (!summary.groups.length) return [{ label: countLabel(), value: 0 }];
    const first = measures[0];
    // Money is grouped per currency too: name it when the groups are in more than one.
    const currencyOf = (g: SummaryBucket) =>
      Object.entries(g.key).find(([k]) => !groupBy.some(([field]) => field === k))?.[1];
    const several = new Set(summary.groups.map(currencyOf)).size > 1;
    return summary.groups.slice(0, KPI_TILES).map((g) => {
      const words = groupBy
        .map(([field, bucket]) => keyText(g.key[field] ?? null, bucket, lang))
        .join(' · ');
      const plain = groupBy.map(([field]) => String(g.key[field] ?? '')).join(' · ');
      const suffix = several ? ` (${String(currencyOf(g))})` : '';
      return {
        label: clip(`${label(plain, () => words)}${suffix}`, 40),
        value: first ? valueText(read(g, first), lang) : g.count,
        ...(first ? { hint: clip(`${t(lang, 'summary.count')}: ${g.count}`, 60) } : {}),
      };
    });
  }

  const several = summary.totals.length > 1;
  return summary.totals
    .flatMap((b) => {
      const currency = several
        ? Object.values(b.key).find((v) => typeof v === 'string')
        : undefined;
      const suffix = currency ? ` (${currency})` : '';
      return [
        { label: clip(`${countLabel()}${suffix}`, 40), value: b.count },
        ...measures.map((m) => ({
          label: clip(`${measureLabel(m)}${suffix}`, 40),
          value: valueText(read(b, m), lang),
        })),
      ];
    })
    .slice(0, KPI_TILES);
}
