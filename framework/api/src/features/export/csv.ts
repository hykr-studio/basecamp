// Records as CSV (RFC 4180) a spreadsheet opens safely: UTF-8 with a byte-order mark, CRLF line
// ends, quoted where needed, objects and arrays as JSON, and no cell a spreadsheet would run as a
// formula.

type Values = Record<string, unknown>;

/** Starts a formula in Excel, LibreOffice or Google Sheets. */
const FORMULA = /^[=+\-@\t\r]/;

/** One value as a cell's text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return FORMULA.test(value) ? `'${value}` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** In `"` when it holds a comma, a `"` or a line end, each `"` inside doubled. */
const quoted = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/**
 * The columns for these rows: the schema's fields in its order, without any no row has (a field
 * hidden from the reader on every row), then any other field the rows have.
 */
export function exportColumns(rows: readonly Values[], schemaKeys: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  const known = schemaKeys.filter((k) => seen.has(k));
  const rest = [...seen].filter((k) => !schemaKeys.includes(k));
  return [...known, ...rest];
}

/** The CSV text: a header, then one line per row. */
export function csvOf(rows: readonly Values[], columns: readonly string[]): string {
  const lines = [columns.map((c) => quoted(cellText(c))).join(',')];
  for (const row of rows) lines.push(columns.map((c) => quoted(cellText(row[c]))).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** The JSON text: an array, one record per line. */
export function jsonOf(rows: readonly Values[]): string {
  if (!rows.length) return '[]\n';
  return `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
}
