// Live updates (B15): GET /api/live streams committed events, as ids, to the people who may read
// the record: the real outbox, relay, Redis pub/sub and access checks, in one process (inline).

import { type LiveMessage, liveMessages, textOf } from '@hykr/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  origin,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { liveApp } from '../fixture/dist/features/live/index.js';

const ana = new Person('Ana Live');
const ravi = new Person('Ravi Live');
const sam = new Person('Sam Live');
const olga = new Person('Olga Live');
let tenantId = '';

type Stream = {
  status: number;
  messages: LiveMessage[];
  /** Everything received, as sent. */
  raw: string;
  ended: boolean;
  close: () => void;
};
const open: Stream[] = [];

/** A live stream for this person (in this business), read in the background. */
async function stream(who: Person | undefined, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(`${server.base}/api/live`, {
    headers: { origin, ...(who ? { cookie: who.cookie } : {}), ...headers },
    signal: controller.signal,
  });
  const s: Stream = {
    status: res.status,
    messages: [],
    raw: '',
    ended: false,
    close: () => controller.abort(),
  };
  open.push(s);
  const body = res.body as ReadableStream<Uint8Array> | null;
  async function* tee() {
    if (!body) return;
    for await (const text of textOf(body)) {
      s.raw += text;
      yield text;
    }
  }
  if (res.ok && body) {
    void (async () => {
      try {
        for await (const m of liveMessages(tee())) s.messages.push(m);
      } catch {
        // aborted
      }
      s.ended = true;
    })();
    await eventually(() => s.messages.find((m) => m.kind === 'ready'));
  }
  return s;
}
const changes = (s: Stream) => s.messages.flatMap((m) => (m.kind === 'change' ? [m.event] : []));
const about = (s: Stream, id: string) => changes(s).filter((e) => e.id === id);
const inAna = { 'x-tenant-id': '' };
/** Long enough for an event to have reached every stream it was going to. */
const settle = () => new Promise((r) => setTimeout(r, 2500));

beforeAll(async () => {
  await boot(liveApp);
  for (const p of [ana, ravi, sam, olga]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  inAna['x-tenant-id'] = tenantId;
  // Sam works on his own rows in Ana's business; Olga sees the whole business.
  await addMember(sam, tenantId, ['staff']);
  await addMember(olga, tenantId, ['ops']);
});
afterAll(async () => {
  for (const s of open) s.close();
  await shutdown();
});

describe('who may open a stream', () => {
  it('nobody without a session; never the assistant', async () => {
    expect((await stream(undefined)).status).toBe(401);
    const agent = await asAssistant(`user:${ana.id}`, { 'x-channel': 'app' })('GET', '/api/live');
    expect(agent.status).toBe(403);
  });
});

describe('what a stream hears', () => {
  let anaS: Stream;
  let raviS: Stream;
  let samS: Stream;
  let olgaS: Stream;
  let taskId = '';

  beforeAll(async () => {
    anaS = await stream(ana);
    raviS = await stream(ravi);
    samS = await stream(sam, inAna);
    olgaS = await stream(olga, inAna);
  });

  it('a change to a record the person may read: its name, type and id, nothing else', async () => {
    const created = await ana.call('POST', '/api/tasks', { title: 'Live secret plan' });
    taskId = created.body.value.id;
    const [event] = await eventually(() => {
      const found = about(anaS, taskId);
      return found.length ? found : undefined;
    });
    expect(event).toEqual({ name: 'task.created', type: 'task', id: taskId });
    // On the wire: exactly those three, never a field of the record.
    expect(anaS.raw).toContain(
      `event: change\ndata: ${JSON.stringify({ name: 'task.created', type: 'task', id: taskId })}\n\n`,
    );
    expect(anaS.raw).not.toContain('secret');
  });

  it('the whole business (ops) hears it; another business and own-rows staff do not', async () => {
    await eventually(() => (about(olgaS, taskId).length ? true : undefined));
    await settle();
    expect(about(raviS, taskId)).toEqual([]);
    expect(about(samS, taskId)).toEqual([]);
    // Sam's own task reaches Sam and Olga, not Ana (her grant is her own rows).
    const own = await sam.call('POST', '/api/tasks', { title: 'Sam’s own' }, inAna);
    const samTask = own.body.value.id;
    await eventually(() => (about(samS, samTask).length ? true : undefined));
    await eventually(() => (about(olgaS, samTask).length ? true : undefined));
    await settle();
    expect(about(anaS, samTask)).toEqual([]);
    expect(about(raviS, samTask)).toEqual([]);
  });

  it('a deletion reaches who made it and who was told of the record; nobody else', async () => {
    const lateOlga = await stream(olga, inAna);
    expect((await ana.call('DELETE', `/api/tasks/${taskId}`)).status).toBe(200);
    const deleted = { name: 'task.deleted', type: 'task', id: taskId };
    await eventually(() => (about(anaS, taskId).some((e) => e.name === 'task.deleted') ? 1 : 0));
    await eventually(() => (about(olgaS, taskId).some((e) => e.name === 'task.deleted') ? 1 : 0));
    await settle();
    expect(about(anaS, taskId)).toContainEqual(deleted);
    // A stream opened after the record was last seen cannot check it any more: it hears nothing.
    expect(about(lateOlga, taskId)).toEqual([]);
    expect(about(samS, taskId)).toEqual([]);
    expect(about(raviS, taskId)).toEqual([]);
  });

  it('an approval appears for the person who decides it, without a reload', async () => {
    const created = await ana.call('POST', '/api/tasks', { title: 'Live parked' });
    const id = created.body.value.id;
    const res = await asAssistant(`user:${ana.id}`, { 'x-channel': 'app' })(
      'DELETE',
      `/api/tasks/${id}`,
    );
    expect(res.body.status).toBe('needs_approval');
    const { rows } = await pool.query(
      `select outcome, actor_kind from audit.events where resource_id = $1 and action = 'task.delete'`,
      [id],
    );
    expect(rows).toEqual([{ outcome: 'needs_approval', actor_kind: 'agent' }]);
    const approval = (
      (await ana.call('GET', '/api/approvals')).body as { id: string; resourceId: string }[]
    ).find((a) => a.resourceId === id);
    if (!approval) throw new Error('no approval for the parked delete');
    const [event] = await eventually(() => {
      const found = about(anaS, approval.id);
      return found.length ? found : undefined;
    });
    expect(event).toEqual({ name: 'approval.requested', type: 'approval', id: approval.id });
    await settle();
    // Only Ana decides her assistant's requests.
    expect(about(olgaS, approval.id)).toEqual([]);
    expect(about(samS, approval.id)).toEqual([]);
    expect(about(raviS, approval.id)).toEqual([]);
    // Deciding it: the decision and the delete it ran reach her too.
    await ana.call('POST', `/api/approvals/${approval.id}/approve`);
    await eventually(() =>
      about(anaS, approval.id).some((e) => e.name === 'approval.decided') ? 1 : 0,
    );
    await eventually(() => (about(anaS, id).some((e) => e.name === 'task.deleted') ? 1 : 0));
  });

  it('a registered check decides a type that is not an entity; an unknown type is never sent', async () => {
    const { LiveHub } = await import('../../dist/features/live/hub.js');
    const hub = server.app?.get(LiveHub, { strict: false });
    const signal = (type: string, id: string) => ({
      event: `e-${id}`,
      name: `${type}.made`,
      tenantId,
      type,
      id,
      actor: { kind: 'system', id: 'fixture' },
      subject: null,
    });
    await hub.fanOut(signal('fixture-thing', 'yes-1'));
    await hub.fanOut(signal('fixture-thing', 'no-1'));
    await hub.fanOut(signal('nothing-known', 'yes-2'));
    // Another business's signal never reaches this business's streams.
    await hub.fanOut({ ...signal('fixture-thing', 'yes-3'), tenantId: (await me(ravi)).tenantId });
    const made = (id: string) => ({ name: 'fixture-thing.made', type: 'fixture-thing', id });
    await eventually(() => (about(anaS, 'yes-1').length ? true : undefined));
    await eventually(() => (about(raviS, 'yes-3').length ? true : undefined));
    await settle();
    expect(about(anaS, 'yes-1')).toEqual([made('yes-1')]);
    expect(about(raviS, 'yes-3')).toEqual([made('yes-3')]);
    expect(about(anaS, 'no-1')).toEqual([]);
    expect(about(anaS, 'yes-2')).toEqual([]);
    expect(about(anaS, 'yes-3')).toEqual([]);
  });
});

describe('stream limits', () => {
  it('a stream closes after its time, so the session is checked again on reconnect', async () => {
    process.env.LIVE_MAX_MS = '300';
    try {
      const s = await stream(ana);
      await eventually(() => (s.ended ? true : undefined), 5000);
    } finally {
      delete process.env.LIVE_MAX_MS;
    }
  });

  it('a person holds at most 8 streams at once', async () => {
    const mine = [];
    for (let i = 0; i < 8; i++) mine.push(await stream(sam));
    expect(mine.every((s) => s.status === 200)).toBe(true);
    expect((await stream(sam)).status).toBe(429);
    for (const s of mine) s.close();
  });
});
