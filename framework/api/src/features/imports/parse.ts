// Reading an import's file: CSV (RFC 4180, with a header row), JSON (an array of objects) or
// NDJSON (one object per line). Nothing here touches the database or Nest.
import type { ImportFormat } from '@hykr/contracts';
import { formulaSafeRead } from '../export/csv.js';

/** One data row as the file gave it. */
export interface RawRow {
  /** Its number among the data rows, from 1 (the error report's `_row`). */
  n: number;
  /** Column → value: text for CSV, any JSON value otherwise. */
  values: Record<string, unknown>;
  /** Why the row cannot be read as a record (too many CSV cells, not a JSON object). */
  problem?: string;
}

export interface ParsedFile {
  format: ImportFormat;
  /** CSV: the header, in order. JSON: every key seen, in the order first seen. */
  columns: string[];
  rows: RawRow[];
  /** CSV: the values are text, given to each field's schema as described in values.ts. */
  text: boolean;
}

/** The file cannot be read at all: the import fails before writing anything. */
export class Unreadable extends Error {}

/** More rows than the deployment allows. */
export class TooManyRows extends Error {}

const BOM = '﻿';

/** The format: as asked, else from the file's type, else from its name; CSV by default. */
export function formatOf(
  asked: ImportFormat | undefined,
  file: { name: string; mime: string },
): ImportFormat {
  if (asked) return asked;
  const mime = file.mime.split(';')[0].trim().toLowerCase();
  if (mime === 'application/json') return 'json';
  if (mime === 'application/x-ndjson') return 'ndjson';
  if (mime === 'text/csv') return 'csv';
  const name = file.name.toLowerCase();
  if (name.endsWith('.ndjson') || name.endsWith('.jsonl')) return 'ndjson';
  if (name.endsWith('.json')) return 'json';
  return 'csv';
}

/** Read the file's bytes in its format. Throws Unreadable or TooManyRows. */
export function parseFile(bytes: Buffer, format: ImportFormat, maxRows: number): ParsedFile {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Unreadable('The file is not UTF-8 text');
  }
  if (text.startsWith(BOM)) text = text.slice(1);
  if (format === 'csv') return parseCsv(text, maxRows);
  return format === 'json' ? parseJson(text, maxRows) : parseNdjson(text, maxRows);
}

/* ── CSV ─────────────────────────────────────────────────────────────────── */

/** The separator a header uses: the most frequent of comma, semicolon and tab outside quoted text. */
export function separatorOf(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  return Object.entries(counts).reduce((best, [sep, n]) => (n > counts[best] ? sep : best), ',');
}

/**
 * RFC 4180 records: fields split by the separator, quoted with `"` (a `"` inside is written `""`),
 * line breaks (LF, CRLF or CR) inside quoted values kept. Each record with the line it starts on.
 */
export function csvRecords(text: string, sep = ','): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    out.push({ line: start, cells });
    cells = [];
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      any = true;
    } else if (ch === sep) {
      endCell();
      any = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (any || cell !== '' || cells.length) endRecord();
      line++;
      start = line;
    } else {
      cell += ch;
      any = true;
    }
  }
  if (quoted) throw new Unreadable(`A quoted value that starts on line ${start} never ends`);
  if (any || cell !== '' || cells.length) endRecord();
  return out;
}

function parseCsv(text: string, maxRows: number): ParsedFile {
  const records = csvRecords(text, separatorOf(text));
  const [header, ...data] = records;
  if (!header) throw new Unreadable('The file is empty: a CSV file starts with a header row');
  const columns = header.cells.map((c) => c.trim());
  const empty = columns.findIndex((c) => !c);
  if (empty >= 0) throw new Unreadable(`Column ${empty + 1} of the header has no name`);
  const twice = columns.find((c, i) => columns.indexOf(c) !== i);
  if (twice) throw new Unreadable(`The header names "${twice}" twice`);
  const rows: RawRow[] = [];
  for (const record of data) {
    // A line of separators only is a blank line.
    if (record.cells.every((c) => c === '')) continue;
    if (rows.length >= maxRows) throw new TooManyRows(`The file has more than ${maxRows} rows`);
    const values: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      // A cell an export or an error report kept from running as a formula reads as it was.
      values[c] = formulaSafeRead(record.cells[i] ?? '');
    });
    const extra = record.cells.length - columns.length;
    const row: RawRow = { n: rows.length + 1, values };
    if (extra > 0 && record.cells.slice(columns.length).some((c) => c !== ''))
      row.problem = `Line ${record.line} has ${record.cells.length} values; the header has ${columns.length}`;
    rows.push(row);
  }
  return { format: 'csv', columns, rows, text: true };
}

/* ── JSON and NDJSON ─────────────────────────────────────────────────────── */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function jsonRows(items: unknown[], maxRows: number, where: (i: number) => string): ParsedFile {
  if (items.length > maxRows) throw new TooManyRows(`The file has more than ${maxRows} rows`);
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows = items.map((item, i): RawRow => {
    if (!isRecord(item))
      return { n: i + 1, values: {}, problem: `${where(i)} is not an object of fields` };
    for (const k of Object.keys(item))
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    return { n: i + 1, values: item };
  });
  return { format: 'json', columns, rows, text: false };
}

function parseJson(text: string, maxRows: number): ParsedFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Unreadable(`The file is not JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!Array.isArray(value)) throw new Unreadable('A JSON import is an array of objects');
  return jsonRows(value, maxRows, (i) => `Item ${i + 1}`);
}

function parseNdjson(text: string, maxRows: number): ParsedFile {
  const items: unknown[] = [];
  const lines: number[] = [];
  text.split(/\r\n|\n|\r/).forEach((line, i) => {
    if (!line.trim()) return;
    if (items.length >= maxRows) throw new TooManyRows(`The file has more than ${maxRows} rows`);
    try {
      items.push(JSON.parse(line));
    } catch {
      throw new Unreadable(`Line ${i + 1} is not JSON`);
    }
    lines.push(i + 1);
  });
  return { ...jsonRows(items, maxRows, (i) => `Line ${lines[i]}`), format: 'ndjson' };
}
