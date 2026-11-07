// Exporting a business's data (A11X), without booting the app: the CSV a spreadsheet opens
// safely, the columns a reader sees, and the zip archive, read back by our reader and by an
// independent one (fflate), and the other way round.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cellText, csvOf, exportColumns, jsonOf } from '../../dist/features/export/csv.js';
import { archiveName } from '../../dist/features/export/job.js';
import { readZip, writeZip, ZipWriter } from '../../dist/features/export/zip.js';

const BOM = '﻿';

describe('CSV', () => {
  it('wraps cells that need it in "…", doubles " inside, ends lines with CRLF, starts with a BOM', () => {
    const text = csvOf(
      [
        { id: 1, title: 'Plain', note: null },
        { id: 2, title: 'Comma, "quoted"', note: 'two\nlines' },
      ],
      ['id', 'title', 'note'],
    );
    expect(text).toBe(`${BOM}id,title,note\r\n1,Plain,\r\n2,"Comma, ""quoted""","two\nlines"\r\n`);
  });

  it('writes Hindi and Telugu as UTF-8', () => {
    const text = csvOf([{ title: 'नमस्ते', other: 'నమస్కారం' }], ['title', 'other']);
    expect(Buffer.from(text, 'utf8').toString('utf8')).toContain('नमस्ते,నమస్కారం');
  });

  it('never starts a cell with a formula', () => {
    for (const s of ['=SUM(A1)', '+1', '-2', '@cmd', '\tx', '\rx'])
      expect(cellText(s)).toBe(`'${s}`);
    // Numbers stay numbers.
    expect(cellText(-2)).toBe('-2');
    expect(cellText('safe = text')).toBe('safe = text');
  });

  it('keeps objects and arrays as JSON, booleans and dates as text', () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(['x', 2])).toBe('["x",2]');
    expect(cellText(true)).toBe('true');
    expect(cellText(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(cellText(undefined)).toBe('');
  });

  it('takes the schema’s columns that the rows have, in order, then any others', () => {
    const rows = [
      { title: 'a', id: '1', extra: 1 },
      { id: '2', title: 'b' },
    ];
    // `cost` is hidden on every row: no column for it.
    expect(exportColumns(rows, ['id', 'title', 'cost'])).toEqual(['id', 'title', 'extra']);
    expect(exportColumns([], ['id'])).toEqual([]);
  });

  it('JSON is an array, one record per line', () => {
    expect(jsonOf([])).toBe('[]\n');
    const text = jsonOf([{ a: 1 }, { a: 2 }]);
    expect(text).toBe('[\n{"a":1},\n{"a":2}\n]\n');
    expect(JSON.parse(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('the zip archive', () => {
  const files = [
    { name: 'manifest.json', data: '{"version":1}\n' },
    { name: 'tasks.csv', data: `${BOM}id,title\r\n${'1,नमस्ते\r\n'.repeat(500)}` },
    // Random bytes do not shrink: stored, not deflated.
    { name: 'noise.bin', data: Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 97) % 251)) },
  ];

  it('is read back by our reader, entry by entry', () => {
    const zip = writeZip(files, new Date('2026-11-07T10:20:30Z'));
    const read = readZip(zip);
    expect([...read.keys()]).toEqual(['manifest.json', 'tasks.csv', 'noise.bin']);
    for (const f of files) expect(read.get(f.name)).toEqual(Buffer.from(f.data));
  });

  it('is read by an independent reader (fflate)', () => {
    const zip = writeZip(files);
    const read = unzipSync(new Uint8Array(zip));
    expect(Object.keys(read).sort()).toEqual(['manifest.json', 'noise.bin', 'tasks.csv']);
    expect(Buffer.from(read['tasks.csv'])).toEqual(Buffer.from(files[1].data));
    expect(strFromU8(read['manifest.json'])).toBe(files[0].data);
    expect(Buffer.from(read['noise.bin'])).toEqual(files[2].data);
  });

  it('reads an archive another writer made (fflate), stored and deflated', () => {
    const zip = zipSync({
      'a.json': [strToU8('[1,2,3]'), { level: 0 }],
      'dir/b.csv': [strToU8('x,y\r\n'.repeat(100)), { level: 9 }],
    });
    const read = readZip(Buffer.from(zip));
    expect(read.get('a.json')?.toString()).toBe('[1,2,3]');
    expect(read.get('dir/b.csv')?.toString()).toBe('x,y\r\n'.repeat(100));
  });

  it('refuses a damaged archive and anything that is not one', () => {
    const zip = writeZip([{ name: 'a.txt', data: 'hello hello hello hello hello' }]);
    const broken = Buffer.from(zip);
    // A byte of the compressed data: its checksum no longer matches (or it no longer inflates).
    broken[30 + 'a.txt'.length + 1] ^= 0xff;
    expect(() => readZip(broken)).toThrow();
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow('Not a zip archive');
  });

  it('counts its size as it grows and refuses a repeated or unsafe name', () => {
    const zip = new ZipWriter();
    expect(zip.size).toBe(0);
    zip.add('a.json', '[]');
    expect(zip.size).toBeGreaterThan(30);
    expect(() => zip.add('a.json', '[]')).toThrow('already has');
    expect(() => zip.add('../evil', 'x')).toThrow('Bad entry name');
    expect(() => zip.add('/abs', 'x')).toThrow('Bad entry name');
  });

  it('is named for the day it was made', () => {
    expect(archiveName(new Date('2026-11-07T23:59:00Z'))).toBe('export-2026-11-07.zip');
  });
});
