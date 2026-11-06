// Live updates in the app, without React Native: what each event invalidates, batching, the
// reconnect delay, the stream's parser, and which links a tapped push may open.
import { liveMessages, readServerSentEvents } from '@hykr/api-client';
import { commandSpec } from '@hykr/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appPathOf } from '../push/links';
import { createInvalidator, type LiveCatalog, liveKeysFor, reconnectDelay } from './keys';

const spec = (name: string, plural: string) => ({ name, plural });
const catalog: LiveCatalog = {
  entities: {
    tasks: spec('task', 'tasks'),
    notes: spec('note', 'notes'),
    files: spec('file', 'files'),
  },
  commands: [
    commandSpec({
      name: 'task.close',
      description: 'Close a task',
      input: z.object({ taskId: z.string() }),
      output: z.object({}),
      http: { method: 'POST', path: '/api/tasks/:taskId/close' },
      expose: 'all',
      touches: ['task', 'note'],
    }),
    commandSpec({
      name: 'file.sweep',
      description: 'Sweep files',
      input: z.object({}),
      output: z.object({}),
      http: { method: 'POST', path: '/api/files/sweep' },
      expose: 'all',
    }),
  ],
};

describe('liveKeysFor', () => {
  it('an entity write invalidates its plural and history', () => {
    expect(liveKeysFor({ name: 'task.updated', type: 'task', id: 't1' }, catalog)).toEqual([
      ['tasks'],
      ['history'],
    ]);
  });
  it("a command's event also invalidates what the type's commands touch", () => {
    expect(liveKeysFor({ name: 'task.closed', type: 'task', id: 't1' }, catalog)).toEqual([
      ['tasks'],
      ['notes'],
      ['history'],
    ]);
    // A command that names nothing may touch everything.
    expect(liveKeysFor({ name: 'file.swept', type: 'file', id: 'f1' }, catalog)).toEqual([
      ['files'],
      ['tasks'],
      ['notes'],
      ['history'],
    ]);
  });
  it('an approval: the list and that approval; a job: every jobs query; an unknown type nothing', () => {
    expect(
      liveKeysFor({ name: 'approval.requested', type: 'approval', id: 'a1' }, catalog),
    ).toEqual([['approvals'], ['approval', 'a1']]);
    expect(liveKeysFor({ name: 'job.progress', type: 'job', id: 'j1' }, catalog)).toEqual([
      ['jobs'],
    ]);
    expect(liveKeysFor({ name: 'thing.made', type: 'thing', id: 'x' }, catalog)).toEqual([]);
  });
});

describe('createInvalidator', () => {
  afterEach(() => vi.useRealTimers());
  it('invalidates each key once per burst, after the wait', () => {
    vi.useFakeTimers();
    const seen: string[][] = [];
    const batch = createInvalidator((key) => seen.push(key), 250);
    batch.add([['tasks'], ['history']]);
    batch.add([['tasks'], ['approvals']]);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(seen).toEqual([['tasks'], ['history'], ['approvals']]);
    batch.add([['notes']]);
    batch.cancel();
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(3);
  });
});

it('reconnects after 1 s, doubling to at most 30 s', () => {
  expect([0, 1, 2, 4, 5, 9].map(reconnectDelay)).toEqual([
    1000, 2000, 4000, 16_000, 30_000, 30_000,
  ]);
});

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('the stream parser', () => {
  it('reads events across chunk boundaries and CRLF, skipping comments', async () => {
    const events = await collect(
      readServerSentEvents(
        chunks(
          'event: ready\r\ndata: {}\r\n\r\n: ping\n\nevent: chan',
          'ge\ndata: {"a":',
          '1}\n\n',
        ),
      ),
    );
    expect(events).toEqual([
      { event: 'ready', data: '{}' },
      { event: 'change', data: '{"a":1}' },
    ]);
  });
  it('keeps the stream’s own events, with only a name, a type and an id', async () => {
    const messages = await collect(
      liveMessages(
        chunks(
          'event: ready\ndata: {}\n\n',
          'event: change\ndata: {"name":"task.created","type":"task","id":"t1","title":"x"}\n\n',
          'event: change\ndata: not json\n\n',
          'event: other\ndata: {"name":"a","type":"b","id":"c"}\n\n',
          'event: change\ndata: {"name":"task.created"}\n\n',
        ),
      ),
    );
    expect(messages).toEqual([
      { kind: 'ready' },
      { kind: 'change', event: { name: 'task.created', type: 'task', id: 't1' } },
    ]);
  });
});

it('a tapped push opens only a path in the app', () => {
  expect(appPathOf({ url: '/todos' })).toBe('/todos');
  expect(appPathOf({ url: 'https://example.com' })).toBeUndefined();
  expect(appPathOf({ url: '//example.com/x' })).toBeUndefined();
  expect(appPathOf({ url: 7 })).toBeUndefined();
  expect(appPathOf(null)).toBeUndefined();
});
