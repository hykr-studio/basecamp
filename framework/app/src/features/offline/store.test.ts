// The web's offline store (IndexedDB, here fake-indexeddb): the outbox keeps each person's items
// in the order they were queued across a reload, and the key-value table keeps the query cache.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { PendingWrite } from '../../framework/write-queue';
import { createOutbox } from './outbox';
import { deviceStore, indexedDbStore, openIndexedDb } from './store';

const item = (id: string, userId: string, createdAt: string): PendingWrite => ({
  id,
  key: `key-${id}`,
  userId,
  tenantId: null,
  op: { kind: 'entity', entity: 'notes', action: 'create', recordId: `rec-${id}` },
  input: { id: `rec-${id}`, title: id },
  createdAt,
  attempts: 0,
  state: 'queued',
});

describe('the IndexedDB store', () => {
  it("keeps each person's items, oldest first, and the key-value table", async () => {
    const store = await deviceStore();
    expect(store.durable).toBe(true);
    await store.outbox.put(item('late', 'u1', '2026-01-01T00:00:00.002Z'));
    await store.outbox.put(item('early', 'u1', '2026-01-01T00:00:00.001Z'));
    await store.outbox.put(item('theirs', 'u2', '2026-01-01T00:00:00.000Z'));
    expect((await store.outbox.load('u1')).map((i) => i.id)).toEqual(['early', 'late']);
    await store.outbox.put({ ...item('late', 'u1', '2026-01-01T00:00:00.002Z'), state: 'failed' });
    await store.outbox.remove('early');
    expect(await store.outbox.load('u1')).toMatchObject([{ id: 'late', state: 'failed' }]);
    await store.kv.setItem('k', 'v');
    expect(await store.kv.getItem('k')).toBe('v');
    await store.kv.removeItem('k');
    expect(await store.kv.getItem('k')).toBeNull();
  });

  it('a write queued offline is still there after a reload, with its key', async () => {
    const first = indexedDbStore(await openIndexedDb(indexedDB));
    const before = createOutbox({
      store: first.outbox,
      send: async () => {
        throw new Error('not sent');
      },
      online: () => false,
    });
    await before.start('u3');
    const queued = await before.submit({
      op: { kind: 'entity', entity: 'notes', action: 'create', recordId: 'r1' },
      input: { id: 'r1', title: 'Offline' },
    });
    expect(queued.status).toBe('queued');
    // The page reloads: another database handle, another outbox.
    const again = indexedDbStore(await openIndexedDb(indexedDB));
    const sent: PendingWrite[] = [];
    const after = createOutbox({
      store: again.outbox,
      send: async (i) => {
        sent.push(i);
        return { status: 'done', value: { id: 'r1' } };
      },
    });
    await after.start('u3');
    expect(sent.map((i) => i.key)).toEqual([queued.status === 'queued' ? queued.item.key : '']);
    expect(await again.outbox.load('u3')).toEqual([]);
  });
});
