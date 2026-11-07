// Bulk import (B20), without booting the app: reading CSV, JSON and NDJSON, choosing the format,
// turning CSV text into the values a field's schema takes, planning columns, and the report.
import { entitySpec, ImportOptions } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { importsConfig } from '../../dist/features/imports/config.js';
import {
  csvRecords,
  formatOf,
  parseFile,
  separatorOf,
  TooManyRows,
  Unreadable,
} from '../../dist/features/imports/parse.js';
import {
  csvCell,
  csvReport,
  ndjsonReport,
  reportFile,
} from '../../dist/features/imports/report.js';
import {
  cellValue,
  fieldsOf,
  planColumns,
  sameValue,
  shapeOf,
} from '../../dist/features/imports/values.js';

const csv = (text: string, max = 100) => parseFile(Buffer.from(text), 'csv', max);

describe('reading CSV', () => {
  it('splits records, with quoted values, "" inside them and line breaks inside them', () => {
    expect(csvRecords('a,b\r\n"x, y","say ""hi"""\n"two\nlines",z\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['x, y', 'say "hi"'] },
      { line: 3, cells: ['two\nlines', 'z'] },
    ]);
  });

  it('reads a header, skips blank lines, a BOM and fills short rows', () => {
    const f = csv('﻿id,title,qty\n1,Bolts,4\n\n2,Nuts\n,,\n');
    expect(f.columns).toEqual(['id', 'title', 'qty']);
    expect(f.text).toBe(true);
    expect(f.rows).toEqual([
      { n: 1, values: { id: '1', title: 'Bolts', qty: '4' } },
      { n: 2, values: { id: '2', title: 'Nuts', qty: '' } },
    ]);
  });

  it('marks a row with more values than the header', () => {
    const f = csv('id,title\n1,A,extra\n2,B,\n');
    expect(f.rows[0].problem).toMatch(/3 values; the header has 2/);
    expect(f.rows[1].problem).toBeUndefined();
  });

  it('takes semicolons or tabs when the header uses them', () => {
    expect(separatorOf('id;title;qty\n1;"a,b";2')).toBe(';');
    expect(separatorOf('id\ttitle\n')).toBe('\t');
    expect(separatorOf('title\n')).toBe(',');
    expect(csv('id;title\n1;"a,b"\n').rows[0].values).toEqual({ id: '1', title: 'a,b' });
  });

  it('refuses what it cannot read', () => {
    expect(() => csv('')).toThrow(Unreadable);
    expect(() => csv('id,,title\n')).toThrow(/Column 2/);
    expect(() => csv('id,id\n')).toThrow(/twice/);
    expect(() => csv('id,title\n1,"never ends\n')).toThrow(/never ends/);
    expect(() => parseFile(Buffer.from([0xff, 0xfe, 0x00]), 'csv', 10)).toThrow(/UTF-8/);
    expect(() => csv('id\n1\n2\n3\n', 2)).toThrow(TooManyRows);
  });
});

describe('reading JSON and NDJSON', () => {
  it('an array of objects, with every key seen', () => {
    const f = parseFile(Buffer.from('[{"id":1,"title":"A"},{"id":2,"qty":3},7]'), 'json', 10);
    expect(f.columns).toEqual(['id', 'title', 'qty']);
    expect(f.text).toBe(false);
    expect(f.rows[0]).toEqual({ n: 1, values: { id: 1, title: 'A' } });
    expect(f.rows[2].problem).toMatch(/Item 3 is not an object/);
    expect(() => parseFile(Buffer.from('{"id":1}'), 'json', 10)).toThrow(/array of objects/);
    expect(() => parseFile(Buffer.from('[1,'), 'json', 10)).toThrow(Unreadable);
    expect(() => parseFile(Buffer.from('[{},{},{}]'), 'json', 2)).toThrow(TooManyRows);
  });

  it('one object per line, blank lines skipped', () => {
    const f = parseFile(Buffer.from('{"id":"a"}\r\n\n{"id":"b","tags":["x"]}\n'), 'ndjson', 10);
    expect(f.format).toBe('ndjson');
    expect(f.rows.map((r) => r.values)).toEqual([{ id: 'a' }, { id: 'b', tags: ['x'] }]);
    expect(() => parseFile(Buffer.from('{"id":1}\nnope\n'), 'ndjson', 10)).toThrow(/Line 2/);
  });

  it('the format: as asked, else the type, else the name, else CSV', () => {
    expect(formatOf('ndjson', { name: 'a.csv', mime: 'text/csv' })).toBe('ndjson');
    expect(formatOf(undefined, { name: 'a.txt', mime: 'application/json' })).toBe('json');
    expect(formatOf(undefined, { name: 'a', mime: 'application/x-ndjson' })).toBe('ndjson');
    expect(formatOf(undefined, { name: 'a.jsonl', mime: 'text/plain' })).toBe('ndjson');
    expect(formatOf(undefined, { name: 'a.JSON', mime: 'text/plain' })).toBe('json');
    expect(formatOf(undefined, { name: 'a.tsv', mime: 'text/plain' })).toBe('csv');
  });
});

describe('values from CSV text', () => {
  const n = z.number().int().min(0).optional();
  it('keeps text a field takes as text', () => {
    expect(cellValue(z.string(), '0042', 'omit')).toBe('0042');
    expect(cellValue(z.uuid(), ' x ', 'omit')).toBe(' x ');
  });
  it('turns text into the number, boolean or JSON a field takes', () => {
    expect(cellValue(n, '42', 'omit')).toBe(42);
    expect(cellValue(n, ' 7 ', 'omit')).toBe(7);
    expect(cellValue(z.boolean(), 'Yes', 'omit')).toBe(true);
    expect(cellValue(z.boolean(), 'false', 'omit')).toBe(false);
    expect(cellValue(z.array(z.string()), '["a","b"]', 'omit')).toEqual(['a', 'b']);
    expect(cellValue(z.record(z.string(), z.unknown()), '{"a":1}', 'omit')).toEqual({ a: 1 });
    const money = z.union([z.string(), z.object({ minor: z.number() })]);
    expect(cellValue(money, '12.50', 'omit')).toBe('12.50');
  });
  it('leaves what does not fit as text, for the schema to refuse', () => {
    expect(cellValue(n, 'many', 'omit')).toBe('many');
    expect(cellValue(n, '-3', 'omit')).toBe('-3');
    expect(cellValue(z.array(z.string()), '[1', 'omit')).toBe('[1');
  });
  it('an empty cell is left out, or null where null fits', () => {
    expect(cellValue(n, '', 'omit')).toBeUndefined();
    expect(cellValue(n, '', 'null')).toBeUndefined();
    expect(cellValue(z.string().nullable().optional(), '', 'null')).toBeNull();
  });
  it('compares values as records show them', () => {
    expect(sameValue({ b: 1, a: [1, 2] }, { a: [1, 2], b: 1 })).toBe(true);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(new Date('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(sameValue(1, '1')).toBe(false);
  });
});

describe('columns to fields', () => {
  const spec = entitySpec({
    name: 'widget',
    label: 'widget',
    description: 'A widget.',
    schemas: {
      read: z.object({ id: z.string(), title: z.string() }),
      create: z.object({ title: z.string(), qty: z.number().optional() }),
      update: z
        .object({ title: z.string().optional(), done: z.boolean().optional() })
        .transform((x) => x),
    },
    list: {
      filterable: {},
      sortable: [],
      defaultSort: [['id', 'asc']],
      pageSize: { default: 10, max: 10 },
    },
  });
  const fields = fieldsOf(spec);
  const o = (more: Partial<ImportOptions> = {}) =>
    ImportOptions.parse({ entity: 'widget', file: crypto.randomUUID(), ...more });

  it('reads both schemas, through a transform', () => {
    expect([...fields.all].sort()).toEqual(['done', 'qty', 'title']);
    expect(Object.keys(shapeOf(spec.schemas.update))).toEqual(['title', 'done']);
  });

  it('maps columns, leaves out the key, `_` columns and nulls, and lists unknown ones', () => {
    const plan = planColumns(
      ['id', 'Name', 'qty', 'done', '_code', 'colour', 'Notes'],
      fields,
      o({ columns: { Name: 'title', Notes: null } }),
    );
    expect([...plan.fieldOf]).toEqual([
      ['Name', 'title'],
      ['qty', 'qty'],
      ['done', 'done'],
    ]);
    expect(plan.unknown).toEqual(['colour']);
    expect(planColumns(['ref', 'title'], fields, o({ key: 'ref' })).unknown).toEqual([]);
  });

  it('options: defaults, a source of lower case, and limits', () => {
    expect(o()).toMatchObject({
      key: 'id',
      source: 'default',
      existing: 'update',
      empty: 'omit',
      dryRun: false,
    });
    expect(() => o({ source: 'Old CRM' })).toThrow();
    expect(() => o({ entity: 'Widget!' } as never)).toThrow();
  });
});

describe('the error report', () => {
  const problems = [
    {
      n: 2,
      code: 'invalid' as const,
      field: 'qty',
      message: 'qty: Too small',
      values: { id: '2', title: 'Say "hi", twice', qty: '-1', _code: 'old' },
    },
    { n: 5, code: 'missing_key' as const, field: 'id', message: 'No id', values: { title: 'X' } },
  ];

  it('as CSV: its own columns first, the row as given, re-readable', () => {
    const text = csvReport(['id', 'title', 'qty', '_code'], problems);
    expect(text).toBe(
      '_row,_code,_field,_message,id,title,qty\r\n' +
        '2,invalid,qty,qty: Too small,2,"Say ""hi"", twice",-1\r\n' +
        '5,missing_key,id,No id,,X,\r\n',
    );
    const back = parseFile(Buffer.from(text), 'csv', 10);
    expect(back.rows[0].values.title).toBe('Say "hi", twice');
  });

  it('as NDJSON, and quoting', () => {
    expect(ndjsonReport(problems).split('\n')[0]).toBe(
      '{"_row":2,"_code":"invalid","_field":"qty","_message":"qty: Too small","id":"2","title":"Say \\"hi\\", twice","qty":"-1"}',
    );
    expect(csvCell(' padded')).toBe('" padded"');
    expect(csvCell(['a'])).toBe('"[""a""]"');
    expect(csvCell(null)).toBe('');
  });

  it('is named after the file, and cut at its limits', () => {
    const all = Array.from({ length: 50 }, (_, i) => ({ ...problems[1], n: i + 1 }));
    const r = reportFile({ name: 'stock.csv', format: 'csv', columns: ['title'] }, all, {
      rows: 10,
      bytes: 1_000_000,
    });
    expect(r.file.name).toBe('stock.errors.csv');
    expect(r.file.mime).toBe('text/csv');
    expect(r).toMatchObject({ rows: 10, truncated: true });
    const small = reportFile({ name: 'x.ndjson', format: 'ndjson', columns: [] }, all, {
      rows: 100,
      bytes: 300,
    });
    expect(small.file.name).toBe('x.errors.ndjson');
    expect(small.file.bytes.length).toBeLessThanOrEqual(300);
    expect(small.truncated).toBe(true);
  });
});

describe('limits', () => {
  it('technical defaults, overridable', () => {
    expect(importsConfig({})).toEqual({
      maxRows: 50_000,
      batchSize: 100,
      reportRows: 10_000,
      timeoutMs: 14_400_000,
    });
    expect(importsConfig({ IMPORTS_BATCH_SIZE: '5000', IMPORTS_MAX_ROWS: 'x' })).toMatchObject({
      batchSize: 1000,
      maxRows: 50_000,
    });
  });
});
