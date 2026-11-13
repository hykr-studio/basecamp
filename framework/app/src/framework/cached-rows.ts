// A record's copies in the app's query cache (B12): a get's row, or an item of a list's pages,
// under the entity's plural. A write reads the freshest copy (the version it is based on) and
// puts the server's answer, or a queued change, into every copy. Pure: tested without React
// Native. docs/decisions/B12.md, decision 13.
import type { QueryClient } from '@tanstack/react-query';

export type Row = Record<string, unknown> & { id?: unknown };

/** Each cached copy of a record in a query's data, through `fn` (null takes it out of a list). */
export function mapRows(data: unknown, id: string, fn: (row: Row) => Row | null): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as Row & { pages?: { items?: Row[] }[] };
  if (d.id === id) return fn(d) ?? data;
  if (!Array.isArray(d.pages)) return data;
  let touched = false;
  const pages = d.pages.map((page) => {
    if (!Array.isArray(page?.items) || !page.items.some((i) => i?.id === id)) return page;
    touched = true;
    return {
      ...page,
      items: page.items.flatMap((i) => (i?.id === id ? (fn(i) ?? []) : [i])),
    };
  });
  return touched ? { ...d, pages } : data;
}

/**
 * The record as the app last read it (a get, or an item of a list), if it is cached. Of several
 * copies (a list fetched before a change and kept since, and one fetched after), the freshest:
 * the highest `versionField` when the entity has versions, else the one fetched last.
 */
export function cachedRecord(
  client: QueryClient,
  name: string,
  id: string,
  opts: { versionField?: string } = {},
): Record<string, unknown> | undefined {
  let best: { row: Row; version: number; at: number } | undefined;
  for (const query of client.getQueryCache().findAll({ queryKey: [name] })) {
    let row: Row | undefined;
    mapRows(query.state.data, id, (r) => {
      row = r;
      return r;
    });
    if (!row) continue;
    const v = opts.versionField ? Number(row[opts.versionField]) : Number.NaN;
    const version = Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
    const at = query.state.dataUpdatedAt;
    if (!best || version > best.version || (version === best.version && at > best.at))
      best = { row, version, at };
  }
  return best?.row;
}

/** Change every cached copy of a record; queries that hold none are left as they are. */
export function patchCached(
  client: QueryClient,
  name: string,
  id: string,
  fn: (row: Row) => Row | null,
): void {
  for (const query of client.getQueryCache().findAll({ queryKey: [name] })) {
    const before = query.state.data;
    const after = mapRows(before, id, fn);
    if (after !== before) client.setQueryData(query.queryKey, after);
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A cached row with a queued patch on it: fields replaced, a nested object (custom) merged. */
export function patched(row: Row, patch: Record<string, unknown>): Row {
  const out: Row = { ...row };
  for (const [k, v] of Object.entries(patch))
    out[k] = isPlain(v) && isPlain(row[k]) ? { ...row[k], ...v } : v;
  return out;
}

/**
 * The server's answer to a write on this record, in every cached copy: a later write (or one
 * queued right after) is then based on the version it made, before the refetch lands. A reply
 * that is not the record (a delete's null) changes nothing.
 */
export function cacheWritten(client: QueryClient, name: string, id: string, value: unknown) {
  if (!isPlain(value) || value.id !== id) return;
  patchCached(client, name, id, (row) => ({ ...row, ...value }));
}
