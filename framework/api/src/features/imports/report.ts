// An import's error report: each row that was not written, why, and the row as the file gave
// it, so the file can be fixed and imported again (columns starting with `_` are not read).
import type { ImportErrorCode, ImportFormat } from '@hykr/contracts';
import { formulaSafe } from '../export/csv.js';

/** One row that was not written. */
export interface Problem {
  /** The row's number among the file's data rows, from 1. */
  n: number;
  code: ImportErrorCode;
  /** The field it is about, when one is. */
  field: string | null;
  message: string;
  /** The row as the file gave it. */
  values: Record<string, unknown>;
}

export const REPORT_COLUMNS = ['_row', '_code', '_field', '_message'] as const;

/**
 * One CSV cell, quoted when it must be. Text that would start a formula gets the export's `'`
 * (formulaSafe), which an import reads back off (parse.ts), so a fixed report imports as given.
 */
export function csvCell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? formulaSafe(value)
        : JSON.stringify(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const own = (columns: readonly string[]) => columns.filter((c) => !c.startsWith('_'));

/** The report as CSV: its own columns, then the file's (an earlier report's `_` ones left out). */
export function csvReport(columns: readonly string[], problems: readonly Problem[]): string {
  const cols = own(columns);
  const lines = [[...REPORT_COLUMNS, ...cols].map(csvCell).join(',')];
  for (const p of problems)
    lines.push(
      [p.n, p.code, p.field ?? '', p.message, ...cols.map((c) => p.values[c])]
        .map(csvCell)
        .join(','),
    );
  return `${lines.join('\r\n')}\r\n`;
}

/** The report as NDJSON: one object per row, its own keys first. */
export function ndjsonReport(problems: readonly Problem[]): string {
  return problems
    .map((p) => {
      const values = Object.fromEntries(
        Object.entries(p.values).filter(([k]) => !k.startsWith('_')),
      );
      return `${JSON.stringify({ _row: p.n, _code: p.code, _field: p.field, _message: p.message, ...values })}\n`;
    })
    .join('');
}

/** The report file for an import of this format: name, type and bytes, within a byte budget. */
export function reportFile(
  input: { name: string; format: ImportFormat; columns: readonly string[] },
  problems: readonly Problem[],
  limits: { rows: number; bytes: number },
): { file: { name: string; mime: string; bytes: Buffer }; rows: number; truncated: boolean } {
  const csv = input.format === 'csv';
  const base = input.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'import';
  const render = (list: readonly Problem[]) =>
    Buffer.from(csv ? csvReport(input.columns, list) : ndjsonReport(list));
  let rows = Math.min(problems.length, limits.rows);
  let bytes = render(problems.slice(0, rows));
  // Over the byte budget: halve until it fits (a report is never larger than files may be).
  while (bytes.length > limits.bytes && rows > 0) {
    rows = Math.floor(rows / 2);
    bytes = render(problems.slice(0, rows));
  }
  return {
    file: {
      name: `${base}.errors.${csv ? 'csv' : 'ndjson'}`,
      mime: csv ? 'text/csv' : 'application/x-ndjson',
      bytes,
    },
    rows,
    truncated: rows < problems.length,
  };
}
