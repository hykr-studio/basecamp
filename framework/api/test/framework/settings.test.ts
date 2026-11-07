// The settings feature's pure parts (A11), without booting: what flags switch off, custom field
// values against their definitions, the `custom` list filter, a business's phrases, the lookup of
// verified origins.
import {
  CustomFieldKey,
  customForCreate,
  customValueFromText,
  customValueProblems,
  defineFeatureFlag,
  entitySpec,
  featureFlagProblems,
  gatedOff,
  listInputSchema,
  listQuerySchema,
  phraseProblems,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { originLookup } from '../../dist/features/settings/domains.js';

describe('feature flags', () => {
  const a = defineFeatureFlag({
    key: 'stock.export',
    label: { en: 'Export', hi: 'निर्यात', te: 'ఎగుమతి' },
    gates: { modules: ['stock'], tools: ['export-stock'], nav: ['/stock'] },
  });
  const b = defineFeatureFlag({
    key: 'stock.bulk',
    label: { en: 'Bulk', hi: 'थोक', te: 'బల్క్' },
    gates: { commands: ['stock.bulk'], tools: ['export-stock'] },
  });

  it('off is what every switched-off flag gates; something two flags gate needs both on', () => {
    expect(gatedOff([a, b], () => false)).toEqual({
      modules: ['stock'],
      entities: [],
      commands: ['stock.bulk'],
      tools: ['export-stock'],
      nav: ['/stock'],
    });
    expect(gatedOff([a, b], (k) => k === 'stock.export').tools).toEqual(['export-stock']);
    expect(gatedOff([a, b], () => true).tools).toEqual([]);
  });

  it('a key is dotted lower case, a nav gate an href', () => {
    const label = { en: 'x', hi: 'x', te: 'x' };
    expect(() => defineFeatureFlag({ key: 'Stock Export', label })).toThrow(/dotted/);
    expect(() => defineFeatureFlag({ key: 'stock.x', label, gates: { nav: ['stock'] } })).toThrow(
      /no href/,
    );
  });

  it('a flag that names something the application does not have is a problem at start', () => {
    const targets = {
      modules: ['stock'],
      entities: ['item'],
      commands: ['stock.bulk'],
      tools: ['export-stock'],
    };
    expect(featureFlagProblems([a, b], targets)).toEqual([]);
    const typo = defineFeatureFlag({
      key: 'stock.typo',
      label: { en: 'x', hi: 'x', te: 'x' },
      gates: { modules: ['stok'], entities: ['itme'], commands: ['stock.bluk'], tools: ['nope'] },
    });
    expect(featureFlagProblems([typo], targets)).toEqual([
      'The feature flag stock.typo gates modules "stok", which is not there',
      'The feature flag stock.typo gates entities "itme", which is not there',
      'The feature flag stock.typo gates commands "stock.bluk", which is not there',
      'The feature flag stock.typo gates tools "nope", which is not there',
    ]);
  });
});

describe('custom field values', () => {
  const fields = [
    { key: 'priority', type: 'select', options: ['low', 'high'], required: true },
    { key: 'estimate', type: 'number', options: [], required: false },
    { key: 'due', type: 'date', options: [], required: false },
    { key: 'urgent', type: 'boolean', options: [], required: false },
  ];

  it('checks each value against its type and options, and required fields when asked', () => {
    expect(
      customValueProblems(
        fields,
        { priority: 'high', estimate: 2, due: '2030-01-01', urgent: true },
        {
          checkRequired: true,
        },
      ),
    ).toEqual([]);
    expect(
      customValueProblems(
        fields,
        { priority: 'mid', estimate: '2', due: 'soon', colour: 'red' },
        {
          checkRequired: true,
        },
      ),
    ).toEqual([
      expect.stringMatching(/^priority:/),
      expect.stringMatching(/^estimate:/),
      expect.stringMatching(/^due:/),
      'colour: no such custom field',
    ]);
    expect(customValueProblems(fields, {}, { checkRequired: true })).toEqual([
      'priority: required',
    ]);
    expect(customValueProblems(fields, {}, { checkRequired: false })).toEqual([]);
  });

  it('keys are camelCase letters and never an operator', () => {
    expect(CustomFieldKey.safeParse('roomCount').success).toBe(true);
    for (const bad of ['room_count', 'Room', 'in', 'gte', 'a1'])
      expect(CustomFieldKey.safeParse(bad).success).toBe(false);
  });

  it("a form's typed-in text becomes the value it sends; an empty one clears", () => {
    expect(customValueFromText('number', ' 3.5 ')).toBe(3.5);
    expect(customValueFromText('number', '-2')).toBe(-2);
    // Not a number: sent as typed, so the server says what is wrong instead of dropping it.
    expect(customValueFromText('number', '0x10')).toBe('0x10');
    expect(customValueFromText('number', 'three')).toBe('three');
    expect(customValueFromText('text', ' Kitchen ')).toBe('Kitchen');
    expect(customValueFromText('date', '2030-01-01')).toBe('2030-01-01');
    expect(customValueFromText('text', '   ')).toBeNull();
  });

  it("a new record's values leave out what the form cleared", () => {
    expect(customForCreate({ priority: 'high', estimate: null, urgent: false })).toEqual({
      priority: 'high',
      urgent: false,
    });
    expect(customForCreate({ priority: null })).toBeUndefined();
    expect(customForCreate({})).toBeUndefined();
    expect(customForCreate(undefined)).toBeUndefined();
  });
});

describe('the custom list filter', () => {
  const spec = entitySpec({
    name: 'thing',
    label: 'thing',
    description: 'Things.',
    schemas: {
      read: z.object({ id: z.string(), title: z.string() }),
      create: z.object({ title: z.string() }),
      update: z.object({ title: z.string().optional() }),
    },
    list: {
      filterable: { title: 'text', custom: 'custom' },
      sortable: [],
      defaultSort: [],
      pageSize: { default: 10, max: 10 },
    },
  });

  it('takes key → value or key → { op: value }, in JSON and in a query string', () => {
    const json = listInputSchema(spec).parse({
      custom: { priority: 'high', estimate: { gte: 3 } },
    });
    expect(json.filters).toEqual([
      { field: 'custom', op: 'eq', value: { priority: 'high', estimate: { gte: 3 } } },
    ]);
    const http = listQuerySchema(spec).parse({ 'custom[priority]': 'high' });
    expect(http.filters).toEqual([{ field: 'custom', op: 'eq', value: { priority: 'high' } }]);
    const asJson = listQuerySchema(spec).parse({ custom: '{"estimate":{"lt":"4"}}' });
    expect(asJson.filters[0].value).toEqual({ estimate: { lt: '4' } });
  });

  it('refuses an operator it does not know, and too many keys', () => {
    expect(listInputSchema(spec).safeParse({ custom: { estimate: { near: 1 } } }).success).toBe(
      false,
    );
    const many = Object.fromEntries('abcdefghijk'.split('').map((k) => [k, 'x']));
    expect(listInputSchema(spec).safeParse({ custom: many }).success).toBe(false);
  });
});

describe("a business's phrases", () => {
  it('must be framework phrases and keep their placeholders', () => {
    expect(phraseProblems({ 'channel.handoff': { en: 'Within {replyTime}.' } })).toEqual([]);
    expect(phraseProblems({ 'channel.handoff': { hi: 'जल्द' } })).toEqual([
      expect.stringMatching(/placeholders \{replyTime\}/),
    ]);
    expect(phraseProblems({ 'no.such': { en: 'x' } })).toEqual(['"no.such" is not a phrase']);
  });
});

describe('verified origins, asked by anyone', () => {
  const acme = 'https://app.acme.example.com';
  const counted = (origins: Record<string, string> = { [acme]: 't-acme' }) => {
    const calls = { n: 0 };
    const lookup = originLookup(async () => {
      calls.n += 1;
      return new Map(Object.entries(origins));
    });
    return { calls, lookup };
  };

  it('one load answers every origin, and an origin nobody verified costs no query', async () => {
    const { calls, lookup } = counted();
    expect(await lookup.tenantOf(acme)).toBe('t-acme');
    for (let i = 0; i < 2000; i++)
      expect(await lookup.tenantOf(`https://r${i}.attacker.example`)).toBeNull();
    expect(calls.n).toBe(1);
  });

  it('never looks up what is not an exact https origin of at most 200 characters', async () => {
    const { calls, lookup } = counted();
    for (const bad of [
      '',
      'null',
      'http://app.acme.example.com',
      `${acme}/path`,
      'https://*.example.com',
      `https://${'a'.repeat(200)}.example.com`,
    ])
      expect(await lookup.tenantOf(bad)).toBeNull();
    expect(calls.n).toBe(0);
  });

  it('askers at the same moment share one load', async () => {
    const { calls, lookup } = counted();
    const answers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => lookup.tenantOf(i % 2 ? acme : `https://x${i}.test`)),
    );
    expect(answers.filter(Boolean)).toHaveLength(25);
    expect(calls.n).toBe(1);
  });

  it('forgetting loads again, and a load that started before it is not kept', async () => {
    let release: () => void = () => {};
    let n = 0;
    // The first load sees the set before the address was verified; it ends after the change.
    const lookup = originLookup(async () => {
      const mine = ++n;
      if (mine === 1) await new Promise<void>((r) => (release = r));
      return new Map(mine === 1 ? [] : [[acme, 't-acme']]);
    });
    const stale = lookup.tenantOf(acme);
    lookup.forget();
    expect(await lookup.tenantOf(acme)).toBe('t-acme');
    release();
    expect(await stale).toBeNull();
    expect(await lookup.tenantOf(acme)).toBe('t-acme');
    expect(n).toBe(2);
  });

  it('a failed load is not kept: the next question tries again', async () => {
    let n = 0;
    const lookup = originLookup(async () => {
      n += 1;
      if (n === 1) throw new Error('database down');
      return new Map([[acme, 't-acme']]);
    });
    await expect(lookup.tenantOf(acme)).rejects.toThrow('database down');
    expect(await lookup.tenantOf(acme)).toBe('t-acme');
  });
});
