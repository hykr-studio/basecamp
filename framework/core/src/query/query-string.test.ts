// A query string's keys are the sender's: `a[b]=c` nesting (nestBrackets) must never reach an
// object's prototype, and the objects it builds without one must still pass every schema
// (docs/decisions/V1.md). The fixture spec has no domain: any entity's lists work alike.
import { parse as parseQueryString } from 'node:querystring';
import { entitySpec, listQuerySchema, nestBrackets, summaryQuerySchema } from '@hykr/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const Thing = z.object({
  id: z.string(),
  title: z.string(),
  units: z.number(),
  dueOn: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
});
const ThingSpec = entitySpec({
  name: 'qsThing',
  label: 'thing',
  description: 'Things.',
  schemas: { read: Thing, create: Thing.omit({ id: true }), update: Thing.partial() },
  list: {
    filterable: {
      title: 'text',
      units: 'number',
      dueOn: 'date',
      location: 'geo',
      custom: 'custom',
    },
    sortable: ['title', 'units'],
    defaultSort: [['title', 'asc']],
    search: ['title'],
    pageSize: { default: 20, max: 100 },
  },
});

/** What Express 5's simple query parser hands a route: Node's querystring, no prototype. */
const query = (s: string) => parseQueryString(s);
const list = (s: string) => listQuerySchema(ThingSpec).safeParse(query(s));
const summary = (s: string) => summaryQuerySchema(ThingSpec).safeParse(query(s));
const polluted = () => Object.keys(Object.prototype);

/** Undo whatever a failing run wrote, so one test's pollution never reaches the next. */
function clean() {
  for (const key of Object.keys(Object.prototype))
    delete (Object.prototype as Record<string, unknown>)[key];
}

afterEach(clean);

describe('nestBrackets', () => {
  it('never writes onto Object.prototype, and keeps a prototype name flat', () => {
    try {
      for (const name of ['__proto__', 'constructor', 'prototype']) {
        const out = nestBrackets(query(`${name}[zz]=1`)) as Record<string, unknown>;
        expect(polluted()).toEqual([]);
        expect(({} as Record<string, unknown>).zz).toBeUndefined();
        expect(Object.keys(out)).toEqual([`${name}[zz]`]);
      }
    } finally {
      clean();
    }
  });

  it('nests every other key into objects with no prototype', () => {
    const out = nestBrackets(query('units[gte]=2&units[lt]=9&title=a')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.getPrototypeOf(out.units)).toBeNull();
    expect({ ...(out.units as object) }).toEqual({ gte: '2', lt: '9' });
    expect(out.title).toBe('a');
  });
});

describe('a list or summary query naming a prototype', () => {
  it('is refused, and every later query still parses', () => {
    try {
      for (const s of [
        '__proto__[x]=1',
        'constructor[x]=1',
        'prototype[x]=1',
        '__proto__=1',
        'custom[colour]=red&__proto__[y]=1',
      ]) {
        const asList = list(s);
        expect(asList.success, s).toBe(false);
        expect(asList.error?.issues[0]?.code, s).toBe('unrecognized_keys');
        expect(summary(s).success, s).toBe(false);
        expect(polluted(), s).toEqual([]);
        // The next request, anyone's, is unaffected.
        expect(list('title=a').success, s).toBe(true);
        expect(summary('groupBy=title').success, s).toBe(true);
      }
    } finally {
      clean();
    }
  });
});

describe('objects with no prototype', () => {
  it('pass every filter kind: operators, lists, a custom filter and a point', () => {
    const r = list(
      [
        'units[gte]=2',
        'title[in]=a,b',
        'dueOn[lt]=2026-12-01',
        'custom[colour]=red',
        'location[near]=12.9716,77.5946,500',
        'sort=-units',
      ].join('&'),
    );
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    const filters = r.success ? r.data.filters : [];
    expect(filters).toEqual(
      expect.arrayContaining([
        { field: 'units', op: 'gte', value: 2 },
        { field: 'title', op: 'in', value: ['a', 'b'] },
        { field: 'dueOn', op: 'lt', value: '2026-12-01' },
        { field: 'location', op: 'near', value: { lat: 12.9716, lng: 77.5946, radiusM: 500 } },
      ]),
    );
    const custom = filters.find((f) => f.field === 'custom');
    expect({ ...(custom?.value as object) }).toEqual({ colour: 'red' });
    // What a filter's value holds reads as text, as the SQL builders use it.
    expect(() => String(Object.keys(custom?.value as object))).not.toThrow();
    const s = summary('units[gte]=2&custom[colour]=red&groupBy=title');
    expect(s.success, JSON.stringify(s.error?.issues)).toBe(true);
  });
});
