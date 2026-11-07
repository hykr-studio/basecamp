// kpi.row: numbers given as items, or tiles computed from an entity's summary (`of`), checked
// against that entity's summary grammar when the registry knows it. No domain: a tiny entity.
import { entitySpec, Money, type Summary } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../registry.js';
import { checkKpiSource, kpiTiles } from './kpi.js';
import { KpiRowView } from './views.js';

const label = (en: string) => ({ en, hi: en, te: en });
const Row = z.object({
  id: z.string(),
  state: z.enum(['open', 'shut']),
  currency: z.string(),
  total: Money,
  units: z.number(),
  bookedAt: z.string(),
});
const RowSpec = entitySpec({
  name: 'kpiRow',
  label: 'row',
  description: 'Rows.',
  schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
  fieldLabels: { total: label('Total'), units: label('Units') },
  list: {
    filterable: { state: 'enum', total: 'money', units: 'number', bookedAt: 'date' },
    sortable: [],
    defaultSort: [],
    pageSize: { default: 20, max: 100 },
  },
  traits: { money: { fields: ['total'] } },
});
const Internal = entitySpec({
  ...RowSpec,
  name: 'hiddenRow',
  plural: 'hiddenRows',
  pascal: 'HiddenRow',
  expose: { list: 'internal', get: 'all', create: 'all', update: 'all', delete: 'all' },
});

const ctx = { entity: (plural: string) => [RowSpec, Internal].find((e) => e.plural === plural) };

describe('kpi.row props', () => {
  const props = KpiRowView.props;
  it('takes items or of, never both or neither', () => {
    expect(props.safeParse({ items: [{ label: 'Open', value: 3 }] }).success).toBe(true);
    expect(props.safeParse({ of: { entity: 'kpiRows' } }).success).toBe(true);
    expect(props.safeParse({}).success).toBe(false);
    expect(
      props.safeParse({ items: [{ label: 'Open', value: 3 }], of: { entity: 'kpiRows' } }).success,
    ).toBe(false);
  });

  it('of is checked against its entity’s summary grammar', () => {
    const of = (query: object, entity = 'kpiRows') => ({ entity, query });
    expect(checkKpiSource(of({ groupBy: ['state'], sum: ['total'] }), ctx)).toBeNull();
    expect(checkKpiSource(of({ groupBy: ['units'] }), ctx)).toMatch(/^of.query:/);
    expect(checkKpiSource(of({}, 'nopes'), ctx)).toBe('of: no entity called nopes');
    expect(checkKpiSource(of({}, 'hiddenRows'), ctx)).toBe('of: hiddenRows cannot be summarized');
    // Without entities (the app's registry), the API checks the query when it runs.
    expect(checkKpiSource(of({ groupBy: ['units'] }), {})).toBeNull();
  });

  it('the registry runs the check on results and pages', () => {
    const registry = createRegistry({ views: [KpiRowView], screens: [], entities: [RowSpec] });
    const present = (of: object) => ({ kind: 'inline' as const, view: 'kpi.row', props: { of } });
    expect(registry.checkPresent(present({ entity: 'kpiRows' }), ['inline'], undefined).kind).toBe(
      'show',
    );
    expect(
      registry.checkPresent(
        present({ entity: 'kpiRows', query: { sum: ['state'] } }),
        ['inline'],
        undefined,
      ),
    ).toMatchObject({ kind: 'error' });
    expect(
      registry.checkPage({
        title: 'Numbers',
        layout: 'stack',
        blocks: [{ id: 'k', view: 'kpi.row', span: 'half', props: { of: { entity: 'nopes' } } }],
      }),
    ).toEqual(['Block "k": Bad props for kpi.row: of: no entity called nopes']);
  });
});

describe('kpiTiles', () => {
  const byState: Summary = {
    groups: [
      { key: { state: 'open' }, count: 3, sum: { units: 12 } },
      { key: { state: 'shut' }, count: 1, sum: { units: 2 } },
    ],
    totals: [{ key: {}, count: 4, sum: { units: 14 } }],
    more: false,
  };

  it('one tile per group: its key, the first measure, the count under it', () => {
    const tiles = kpiTiles(
      byState,
      { entity: 'kpiRows', query: { groupBy: ['state'], sum: ['units'] } },
      { spec: RowSpec, lang: 'en' },
    );
    expect(tiles).toEqual([
      { label: 'open', value: 12, hint: 'Count: 3' },
      { label: 'shut', value: 2, hint: 'Count: 1' },
    ]);
  });

  it('labels by key or measure override the words', () => {
    const tiles = kpiTiles(
      byState,
      { entity: 'kpiRows', query: { groupBy: 'state' }, labels: { open: 'Waiting' } },
      { spec: RowSpec, lang: 'en' },
    );
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['Waiting', 3],
      ['shut', 1],
    ]);
  });

  it('without groups: the count, then each measure, per currency', () => {
    const summary: Summary = {
      groups: [],
      totals: [
        { key: { currency: 'EUR' }, count: 2, sum: { total: { minor: 12345, currency: 'EUR' } } },
        { key: { currency: 'USD' }, count: 1, sum: { total: { minor: 500, currency: 'USD' } } },
      ],
      more: false,
    };
    const tiles = kpiTiles(
      summary,
      { entity: 'kpiRows', query: { sum: 'total' }, labels: { 'sum:total': 'Booked' } },
      { spec: RowSpec, lang: 'en' },
    );
    expect(tiles.map((t) => t.label)).toEqual([
      'Count (EUR)',
      'Booked (EUR)',
      'Count (USD)',
      'Booked (USD)',
    ]);
    expect(tiles[1].value).toMatch(/123\.45/);
  });

  it('months read as months; a missing value as a dash; at most four tiles', () => {
    const summary: Summary = {
      groups: ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'].map((m) => ({
        key: { bookedAt: m },
        count: 1,
        avg: { units: null },
      })),
      totals: [{ key: {}, count: 5 }],
      more: false,
    };
    const tiles = kpiTiles(
      summary,
      { entity: 'kpiRows', query: { groupBy: 'bookedAt:month', avg: 'units' } },
      { spec: RowSpec, lang: 'en' },
    );
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toMatchObject({ label: 'Aug 2026', value: '—' });
  });

  it('no groups at all: a zero count', () => {
    const tiles = kpiTiles(
      { groups: [], totals: [{ key: {}, count: 0 }], more: false },
      { entity: 'kpiRows', query: { groupBy: 'state' } },
      { lang: 'en' },
    );
    expect(tiles).toEqual([{ label: 'Count', value: 0 }]);
  });

  it('the view puts a summary into words through its load', async () => {
    const loaded = await KpiRowView.load?.(
      { of: { entity: 'kpiRows', query: { groupBy: 'state' } } },
      {
        lang: 'en',
        timeZone: 'UTC',
        entity: () => RowSpec,
        summary: async (plural, query) => {
          expect([plural, query]).toEqual(['kpiRows', { groupBy: 'state' }]);
          return byState;
        },
      },
    );
    expect(KpiRowView.text(loaded as never, { lang: 'en', timeZone: 'UTC' })).toBe(
      'open: 3\nshut: 1',
    );
  });
});
