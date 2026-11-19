// The outbox, without React Native (decisions B12): a write keeps the key it was given when it
// was queued, items go in order, a network failure stops the run and keeps them, a server error
// waits and gives up after a few tries, a 401 pauses, a refusal fails the item (or rejects the
// caller still waiting) and the run goes on, a write that parks leaves, a conflict can be applied
// again on the current version, and each person sees only their own items.
import { ApiError, NetworkError } from '@hykr/api-client';
import type { WriteResult } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import type { PendingWrite, WriteDraft } from '../../framework/write-queue';
import {
  backoffMs,
  createOutbox,
  dispositionOf,
  MAX_ATTEMPTS,
  memoryStore,
  type Settled,
} from './outbox';

type Reply = WriteResult<unknown> | Error;

/** An outbox over memory, a clock the test moves, and a server that answers from a script. */
function setup(opts: { online?: boolean; replies?: Reply[] } = {}) {
  const store = memoryStore();
  const sent: PendingWrite[] = [];
  const replies = [...(opts.replies ?? [])];
  let online = opts.online ?? true;
  let clock = 1_000_000;
  let n = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const settled: Settled[] = [];
  const readable = new Map<string, unknown>();
  const outbox = createOutbox({
    store,
    send: async (item) => {
      sent.push(structuredClone(item));
      const reply = replies.shift() ?? { status: 'done', value: { id: item.op.kind } };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    read: async (item) =>
      item.op.kind === 'entity' && item.op.recordId ? readable.get(item.op.recordId) : undefined,
    online: () => online,
    business: () => 'b1',
    now: () => clock,
    newId: () => `id-${++n}`,
    later: (fn, ms) => {
      const t = { at: clock + ms, fn };
      timers.push(t);
      return () => {
        timers.splice(timers.indexOf(t), 1);
      };
    },
  });
  outbox.onSettled((s) => settled.push(s));
  return {
    outbox,
    store,
    sent,
    replies,
    settled,
    readable,
    timers,
    setOnline: (v: boolean) => {
      online = v;
    },
    /** Move the clock on and run the timers that are due. */
    tick: async (ms: number) => {
      clock += ms;
      for (const t of timers.filter((x) => x.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
      await outbox.flush();
    },
  };
}

const create = (title: string, id = `rec-${title}`): WriteDraft => ({
  op: { kind: 'entity', entity: 'notes', action: 'create', recordId: id },
  input: { id, title },
  title,
  versioned: true,
});
const update = (id: string, patch: object, baseVersion?: number): WriteDraft => ({
  op: { kind: 'entity', entity: 'notes', action: 'update', recordId: id },
  input: { ...patch },
  versioned: true,
  ...(baseVersion !== undefined ? { baseVersion } : {}),
});
const refused = (status: number, body: object) => new ApiError(status, body);
const offline = () => new NetworkError(new TypeError('Network request failed'));

describe('the outbox', () => {
  it('sends a write at once when online, and keeps nothing after', async () => {
    const t = setup();
    await t.outbox.start('u1');
    const r = await t.outbox.submit(create('A'));
    expect(r).toEqual({ status: 'done', value: { id: 'entity' } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      userId: 'u1',
      tenantId: 'b1',
      key: 'id-2',
      state: 'sending',
    });
    expect(t.store.all()).toEqual([]);
    expect(t.settled[0]).toMatchObject({ outcome: 'done', attached: true });
  });

  it('keeps a write made offline, with its key, and sends it in order when back', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    const a = await t.outbox.submit(create('A'));
    const b = await t.outbox.submit(update('rec-A', { title: 'A2' }));
    expect(a.status).toBe('queued');
    expect(b.status).toBe('queued');
    expect(t.sent).toEqual([]);
    expect(t.store.all().map((i) => i.title ?? i.op.kind)).toEqual(['A', 'entity']);
    const keys = t.outbox.items().map((i) => i.key);
    t.setOnline(true);
    await t.outbox.flush();
    expect(t.sent.map((i) => i.key)).toEqual(keys);
    expect(t.sent.map((i) => (i.op.kind === 'entity' ? i.op.action : ''))).toEqual([
      'create',
      'update',
    ]);
    expect(t.outbox.items()).toEqual([]);
    // Not waited for any more: the screen hears of it from onSettled.
    expect(t.settled.map((s) => s.attached)).toEqual([false, false]);
  });

  it('sends the same key again after a network failure, and waits longer each time', async () => {
    const t = setup({ replies: [offline(), offline()] });
    await t.outbox.start('u1');
    const r = await t.outbox.submit(create('A'));
    expect(r.status).toBe('queued');
    expect(t.timers.map((x) => x.at - 1_000_000)).toEqual([backoffMs(1)]);
    await t.tick(backoffMs(1));
    expect(t.timers.map((x) => x.at - 1_000_000 - backoffMs(1))).toEqual([backoffMs(2)]);
    await t.tick(backoffMs(2));
    expect(t.sent).toHaveLength(3);
    expect(new Set(t.sent.map((i) => i.key)).size).toBe(1);
    expect(t.outbox.items()).toEqual([]);
  });

  it('a write the app was closed in the middle of is sent again, with its key', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(create('A'));
    const [kept] = t.store.all();
    await t.store.put({ ...kept, state: 'sending' });
    t.setOnline(true);
    await t.outbox.start('u1');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].key).toBe(kept.key);
  });

  it('a server error waits, then the item is left for the person after a few tries', async () => {
    const t = setup({
      replies: Array.from({ length: MAX_ATTEMPTS }, () => refused(503, { message: 'Busy' })),
    });
    await t.outbox.start('u1');
    expect((await t.outbox.submit(create('A'))).status).toBe('queued');
    for (let i = 1; i < MAX_ATTEMPTS; i++) await t.tick(backoffMs(i));
    expect(t.sent).toHaveLength(MAX_ATTEMPTS);
    const [item] = t.outbox.items();
    expect(item).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    expect(item.error).toMatchObject({ status: 503, message: 'Busy' });
    expect(t.settled.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('a 401 pauses the queue until the person signs in again', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(create('A'));
    t.replies.push(refused(401, {}));
    t.setOnline(true);
    await t.outbox.flush();
    expect(t.outbox.paused()).toBe(true);
    expect(t.outbox.items()[0].state).toBe('queued');
    await t.outbox.flush();
    expect(t.sent).toHaveLength(1);
    await t.outbox.start('u1');
    expect(t.outbox.paused()).toBe(false);
    expect(t.sent).toHaveLength(2);
    expect(t.outbox.items()).toEqual([]);
  });

  it('a refusal fails that item, keeps its reason, and the next one goes on', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(update('rec-X', { title: 'Mine' }, 3));
    await t.outbox.submit(create('B'));
    t.replies.push(refused(409, { error: 'stale', message: 'It changed' }));
    t.setOnline(true);
    await t.outbox.flush();
    expect(t.sent).toHaveLength(2);
    const [left] = t.outbox.items();
    expect(left).toMatchObject({ state: 'failed', ifMatch: 3 });
    expect(left.error).toEqual({ status: 409, code: 'stale', message: 'It changed' });
    expect(t.settled.map((s) => s.outcome)).toEqual(['failed', 'done']);
  });

  it('a refusal while the screen waits rejects it, as a direct call would, and keeps nothing', async () => {
    const t = setup({
      replies: [refused(403, { error: 'forbidden', rule: 'no_access', reason: 'No' })],
    });
    await t.outbox.start('u1');
    await expect(t.outbox.submit(create('A'))).rejects.toBeInstanceOf(ApiError);
    expect(t.outbox.items()).toEqual([]);
    expect(t.store.all()).toEqual([]);
  });

  it('a write that parks for approval when it syncs leaves the outbox', async () => {
    const parked = {
      status: 'needs_approval',
      approval: { id: 'ap1', summary: 'Create note "A"' },
    } as unknown as WriteResult<unknown>;
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(create('A'));
    t.replies.push(parked);
    t.setOnline(true);
    await t.outbox.flush();
    expect(t.outbox.items()).toEqual([]);
    expect(t.settled[0]).toMatchObject({ outcome: 'parked', attached: false, result: parked });
  });

  it('a conflict is applied again on the current version only when the person asks', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(update('rec-X', { title: 'Mine' }, 3));
    t.replies.push(refused(409, { error: 'stale', message: 'It changed' }));
    t.setOnline(true);
    await t.outbox.flush();
    const [failed] = t.outbox.items();
    // Try again as it was: the same key and version.
    t.replies.push(refused(409, { error: 'stale', message: 'Still' }));
    await t.outbox.retry(failed.id);
    expect(t.sent[1]).toMatchObject({ key: failed.key, ifMatch: 3 });
    // Over theirs: a new request, on whatever version is there now.
    await t.outbox.retry(failed.id, { overwrite: true });
    expect(t.sent[2].key).not.toBe(failed.key);
    expect(t.sent[2]).not.toHaveProperty('ifMatch');
    expect(t.outbox.items()).toEqual([]);
  });

  it('a create whose id is taken by its own earlier try is done', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(create('A'));
    t.replies.push(refused(409, { error: 'id_taken', message: 'Taken' }));
    t.readable.set('rec-A', { id: 'rec-A', title: 'A' });
    t.setOnline(true);
    await t.outbox.flush();
    expect(t.outbox.items()).toEqual([]);
    expect(t.settled[0]).toMatchObject({ outcome: 'done', result: { value: { id: 'rec-A' } } });
  });

  it('works out the version each change is based on, after the changes still waiting', async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(update('rec-X', { title: '1' }, 4));
    await t.outbox.submit(update('rec-X', { title: '2' }, 4));
    await t.outbox.submit(create('N'));
    await t.outbox.submit(update('rec-N', { title: 'N2' }));
    await t.outbox.submit({ ...update('rec-Y', { title: 'y' }, 9), versioned: false });
    expect(t.outbox.items().map((i) => i.ifMatch)).toEqual([4, 5, undefined, 1, undefined]);
  });

  it("discards an item, and never sends another person's", async () => {
    const t = setup({ online: false });
    await t.outbox.start('u1');
    await t.outbox.submit(create('Mine'));
    t.outbox.stop();
    await t.outbox.start('u2');
    expect(t.outbox.items()).toEqual([]);
    await t.outbox.submit(create('Theirs'));
    const [theirs] = t.outbox.items();
    await t.outbox.discard(theirs.id);
    expect(t.store.all().map((i) => i.userId)).toEqual(['u1']);
    t.setOnline(true);
    await t.outbox.flush();
    expect(t.sent).toEqual([]);
  });

  it('reads failures the way it acts on them', () => {
    expect(dispositionOf(offline())).toBe('offline');
    expect(dispositionOf(new TypeError('Failed to fetch'))).toBe('offline');
    expect(dispositionOf(refused(401, {}))).toBe('signed-out');
    expect(dispositionOf(refused(429, {}))).toBe('later');
    expect(dispositionOf(refused(502, {}))).toBe('later');
    expect(dispositionOf(refused(404, {}))).toBe('refused');
    expect(dispositionOf(refused(409, {}))).toBe('refused');
  });
});
