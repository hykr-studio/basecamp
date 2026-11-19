// A record's cached copies (decisions B12, decision 13): a write is based on the freshest copy,
// not the first one cached, and the server's answer reaches every copy. Otherwise a list fetched
// before a change and kept since (the 'Open' filter, left for 'All') sends its old version as
// If-Match, and the server refuses the write as stale.
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { cachedRecord, cacheWritten, mapRows, patchCached, type Row } from './cached-rows';

type Item = { id: string; title: string; done: boolean; version: number };
const list = (...items: Item[]) => ({ pages: [{ items, nextCursor: null }], pageParams: [null] });
const x = (version: number, done = false): Item => ({ id: 'x', title: 'Call', done, version });
const other: Item = { id: 'y', title: 'Write', done: false, version: 4 };
const open = ['todos', 'list', { filter: 'open' }];
const all = ['todos', 'list', { filter: 'all' }];
const get = ['todos', 'get', 'x'];

const versionField = 'version';

/** The copy of x one query holds. */
function copy(client: QueryClient, key: readonly unknown[]) {
  let found: Row | undefined;
  mapRows(client.getQueryData(key), 'x', (row) => {
    found = row;
    return row;
  });
  return found;
}

describe('cachedRecord', () => {
  it('takes the copy with the highest version, whichever list was cached first', () => {
    const client = new QueryClient();
    client.setQueryData(open, list(x(1)), { updatedAt: 1000 });
    client.setQueryData(all, list(other, x(2, true)), { updatedAt: 2000 });
    expect(cachedRecord(client, 'todos', 'x', { versionField })).toMatchObject({ version: 2 });

    // A copy fetched later but older (a reply that was slow to arrive) does not win either.
    const late = new QueryClient();
    late.setQueryData(all, list(x(2, true)), { updatedAt: 1000 });
    late.setQueryData(open, list(x(1)), { updatedAt: 2000 });
    late.setQueryData(get, x(1), { updatedAt: 3000 });
    expect(cachedRecord(late, 'todos', 'x', { versionField })).toMatchObject({ version: 2 });
  });

  it('takes the copy fetched last when the entity has no versions', () => {
    const client = new QueryClient();
    client.setQueryData(open, list({ ...x(1), title: 'Old' }), { updatedAt: 1000 });
    client.setQueryData(get, { ...x(1), title: 'New' }, { updatedAt: 3000 });
    client.setQueryData(all, list({ ...x(1), title: 'Middle' }), { updatedAt: 2000 });
    expect(cachedRecord(client, 'todos', 'x')).toMatchObject({ title: 'New' });
  });

  it('reads only this entity, and nothing when the record is not cached', () => {
    const client = new QueryClient();
    client.setQueryData(['meetings', 'get', 'x'], { id: 'x', title: 'A meeting', version: 9 });
    client.setQueryData(all, list(other));
    expect(cachedRecord(client, 'todos', 'x', { versionField })).toBeUndefined();
    client.setQueryData(open, list(x(1)));
    expect(cachedRecord(client, 'todos', 'x', { versionField })).toMatchObject({ version: 1 });
  });
});

describe('cacheWritten', () => {
  it("puts the server's answer in every copy, so the next write is based on its version", () => {
    const client = new QueryClient();
    client.setQueryData(open, list(x(1)), { updatedAt: 1000 });
    client.setQueryData(all, list(other, x(1)), { updatedAt: 1000 });
    client.setQueryData(get, x(1), { updatedAt: 1000 });
    const untouched = ['todos', 'list', { filter: 'done' }];
    const kept = list(other);
    client.setQueryData(untouched, kept, { updatedAt: 1000 });

    cacheWritten(client, 'todos', 'x', x(2, true));

    for (const key of [open, all, get]) expect(copy(client, key)).toEqual(x(2, true));
    expect(cachedRecord(client, 'todos', 'x', { versionField })).toMatchObject({ version: 2 });
    // The other rows stay, and a list without the record is not touched (nor made fresh).
    expect(client.getQueryData<ReturnType<typeof list>>(all)?.pages[0]?.items[0]).toEqual(other);
    expect(client.getQueryData(untouched)).toBe(kept);
    expect(client.getQueryState(untouched)?.dataUpdatedAt).toBe(1000);
  });

  it('keeps fields the answer leaves out, and ignores an answer that is not the record', () => {
    const client = new QueryClient();
    client.setQueryData(all, list({ ...x(1), extra: 'from the list' } as Item));
    cacheWritten(client, 'todos', 'x', { id: 'x', version: 2 });
    expect(cachedRecord(client, 'todos', 'x')).toMatchObject({
      extra: 'from the list',
      version: 2,
    });

    const before = client.getQueryData(all);
    cacheWritten(client, 'todos', 'x', null);
    cacheWritten(client, 'todos', 'x', { id: 'z', version: 7 });
    expect(client.getQueryData(all)).toBe(before);
  });

  it('a queued delete takes the record out of the lists that hold it', () => {
    const client = new QueryClient();
    client.setQueryData(all, list(other, x(1)));
    client.setQueryData(open, list(other), { updatedAt: 1000 });
    patchCached(client, 'todos', 'x', () => null);
    expect(client.getQueryData<ReturnType<typeof list>>(all)?.pages[0]?.items).toEqual([other]);
    expect(client.getQueryState(open)?.dataUpdatedAt).toBe(1000);
  });
});
