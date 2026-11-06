// The settings feature's pure parts (A11), without booting: what flags switch off, custom field
// values against their definitions, the `custom` list filter, a business's phrases.
import {
  CustomFieldKey,
  customValueProblems,
  defineFeatureFlag,
  entitySpec,
  gatedOff,
  listInputSchema,
  listQuerySchema,
  phraseProblems,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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
