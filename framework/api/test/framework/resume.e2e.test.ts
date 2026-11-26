// Durable runs (A7): an assistant's run that waits for an approval is stored by Mastra and goes on
// when the request is decided, in the person's thread, under the same run id. The real outbox,
// relay, queue and Mastra storage, in one process (the worker runs inline).

import { type LiveMessage, liveMessages, textOf } from '@hykr/api-client';
import { ApprovalService } from '@hykr/core';
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
  runtime,
  server,
  shutdown,
} from '../../dist/testing.js';
import { resumeApp, seen } from '../fixture/dist/features/resume/index.js';

const ana = new Person('Ana Resume');
const sam = new Person('Sam Resume');
const bob = new Person('Bob Resume');
let tenantId = '';

type Message = {
  id: string;
  role: string;
  parts: { type: string; text?: string; output?: { result?: { status?: string } } }[];
  metadata: { runId: string | null };
};

const threadOf = async (who: Person) =>
  (await who.call('GET', '/api/threads/current')).body.id as string;
const messages = async (who: Person, threadId: string) =>
  (await who.call('GET', `/api/threads/${threadId}/messages`)).body as Message[];
const textOfMessage = (m: Message) =>
  m.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join('\n');

/** The run's messages after the turn that parked: what it said once it went on. */
async function continuation(who: Person, threadId: string, runId: string, after: number) {
  return eventually(async () => {
    const mine = (await messages(who, threadId)).filter((m) => m.metadata.runId === runId);
    return mine.length > after ? mine[after] : undefined;
  }, 20_000);
}

async function task(who: Person, title: string) {
  const res = await who.call('POST', '/api/tasks', { title });
  expect(res.status).toBe(201);
  return res.body.value as { id: string };
}

/** "tidy <title>": the turn parks the delete and says so. */
async function tidy(who: Person, title: string) {
  const chat = await who.chat(`tidy ${title}`);
  expect(chat.status).toBe(200);
  const parked = chat.body.toolCalls.find((c: { tool: string }) => c.tool === 'delete-task');
  expect(parked).toMatchObject({ ok: true, outcome: 'parked', approvalId: expect.any(String) });
  return {
    runId: chat.body.runId as string,
    threadId: chat.body.threadId as string,
    approvalId: parked.approvalId as string,
    reply: chat.body.reply as string,
  };
}

/** A live stream for this person, read in the background. */
async function live(who: Person) {
  const controller = new AbortController();
  const res = await fetch(`${server.base}/api/live`, {
    headers: { origin, cookie: who.cookie, 'x-tenant-id': tenantId },
    signal: controller.signal,
  });
  const got: LiveMessage[] = [];
  const body = res.body as ReadableStream<Uint8Array>;
  void (async () => {
    try {
      for await (const m of liveMessages(textOf(body))) got.push(m);
    } catch {
      // closed
    }
  })();
  await eventually(() => got.find((m) => m.kind === 'ready'));
  const events = () => got.flatMap((m) => (m.kind === 'change' ? [m.event] : []));
  return { events, close: () => controller.abort() };
}

beforeAll(async () => {
  await boot(resumeApp);
  for (const p of [ana, sam, bob]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  // Sam works in Ana's business; Bob has his own.
  await addMember(sam, tenantId, ['staff']);
});
afterAll(shutdown);

describe('a run that waits for an approval', () => {
  it('parks, answers as before, and is stored by Mastra under the turn’s run id', async () => {
    await task(ana, 'Old notes');
    const run = await tidy(ana, 'Old notes');
    expect(run.reply).toBe(
      'I\'ve asked for your approval: Delete "Old notes". Nothing changes until you approve it.',
    );
    const s = await runtime().agents.findSuspension({
      runId: run.runId,
      approvalId: run.approvalId,
    });
    expect(s).toMatchObject({ runId: run.runId, toolName: 'delete-task' });
    expect(s?.parked.context).toMatchObject({ actingFor: `user:${ana.id}`, tenantId });
    // The park is audited under the run.
    const { rows } = await pool.query(
      `select outcome from audit.events where run_id = $1 and action = 'task.delete'`,
      [run.runId],
    );
    expect(rows).toEqual([{ outcome: 'needs_approval' }]);
    await ana.call('POST', `/api/approvals/${run.approvalId}/reject`);
    await continuation(ana, run.threadId, run.runId, 1);
  });

  it('goes on once approved: in the thread, under the same run, and only its owner hears it', async () => {
    const kept = await task(ana, 'Keep this');
    const gone = await task(ana, 'Old drafts');
    const run = await tidy(ana, 'Old drafts');
    const [anaLive, samLive] = [await live(ana), await live(sam)];
    try {
      const approved = await ana.call('POST', `/api/approvals/${run.approvalId}/approve`);
      expect(approved.body.status).toBe('approved');
      const next = await continuation(ana, run.threadId, run.runId, 1);
      expect(textOfMessage(next)).toMatch(/^Tidied "Old drafts"\. \d+ left\.$/);
      // What it did after the decision, as tool parts: the decision, the write, the list.
      expect(next.parts.map((p) => p.type)).toEqual([
        'tool-delete-task',
        'tool-create-task',
        'tool-list-tasks',
        'text',
      ]);
      expect(next.parts[0].output?.result?.status).toBe('approved');
      // The delete ran once, by the approval's replay; the follow-on write is under the same run.
      expect((await ana.call('GET', `/api/tasks/${gone.id}`)).status).toBe(404);
      expect((await ana.call('GET', `/api/tasks/${kept.id}`)).status).toBe(200);
      const { rows } = await pool.query(
        `select action, outcome, actor_kind, approved_by from audit.events
          where run_id = $1 and action like 'task.%' order by at, action`,
        [run.runId],
      );
      expect(rows.map((r) => `${r.action}/${r.outcome}/${r.actor_kind}`)).toEqual([
        'task.delete/needs_approval/agent',
        'task.delete/committed/agent',
        'task.create/committed/agent',
      ]);
      // Mastra no longer holds it: the run ended.
      expect(
        await runtime().agents.findSuspension({ runId: run.runId, approvalId: run.approvalId }),
      ).toBeUndefined();
      // The turn hooks saw the resumed run as a turn of its own kind.
      expect(seen.turns.find((t) => t.kind === 'resume' && t.runId === run.runId)).toMatchObject({
        threadId: run.threadId,
        message: 'tidy Old drafts',
      });
      // The app hears that the thread changed; nobody else in the business does.
      await eventually(() =>
        anaLive.events().find((e) => e.type === 'thread' && e.id === run.threadId),
      );
      await new Promise((r) => setTimeout(r, 1500));
      expect(samLive.events().filter((e) => e.type === 'thread')).toEqual([]);
    } finally {
      anaLive.close();
      samLive.close();
    }
  });

  it('rejected: says nothing changed, and does not go on', async () => {
    const t = await task(ana, 'Receipts');
    const run = await tidy(ana, 'Receipts');
    await ana.call('POST', `/api/approvals/${run.approvalId}/reject`);
    const next = await continuation(ana, run.threadId, run.runId, 1);
    expect(textOfMessage(next)).toBe('That was rejected, so nothing changed: Delete "Receipts".');
    expect(next.parts.map((p) => p.type)).toEqual(['tool-delete-task', 'text']);
    expect((await ana.call('GET', `/api/tasks/${t.id}`)).status).toBe(200);
  });

  it('expired by the sweeper: the run goes on with that', async () => {
    await task(ana, 'Old invoices');
    const run = await tidy(ana, 'Old invoices');
    await pool.query(
      `update app.approvals set expires_at = now() - interval '1 minute' where id = $1`,
      [run.approvalId],
    );
    expect(await server.app?.get(ApprovalService, { strict: false }).expireDue()).toBeGreaterThan(
      0,
    );
    const next = await continuation(ana, run.threadId, run.runId, 1);
    expect(textOfMessage(next)).toBe(
      'Nobody decided it in time, so nothing changed: Delete "Old invoices".',
    );
  });

  it('two requests of one run decided together: resumed one at a time, the run goes on once', async () => {
    const piles = [await task(ana, 'First pile'), await task(ana, 'Second pile')];
    const chat = await ana.chat('tidy both First pile and Second pile');
    expect(chat.status).toBe(200);
    const parked = (chat.body.toolCalls as { tool: string; outcome: string; approvalId: string }[])
      .filter((c) => c.tool === 'delete-task')
      .map((c) => {
        expect(c.outcome).toBe('parked');
        return c.approvalId;
      });
    expect(parked).toHaveLength(2);
    const { runId, threadId } = chat.body as { runId: string; threadId: string };
    // Both at once: the second waits for the first's resume (the run's lock), then resumes its own.
    await Promise.all(parked.map((id) => ana.call('POST', `/api/approvals/${id}/approve`)));
    const next = await continuation(ana, threadId, runId, 1);
    expect(textOfMessage(next)).toBe('Both decided: approved and approved.');
    for (const t of piles) expect((await ana.call('GET', `/api/tasks/${t.id}`)).status).toBe(404);
    for (const approvalId of parked)
      expect(await runtime().agents.findSuspension({ runId, approvalId })).toBeUndefined();
    // The decision that came first said nothing: the run went on, once, after the second.
    await new Promise((r) => setTimeout(r, 1500));
    const said = (await messages(ana, threadId)).filter((m) => m.metadata.runId === runId);
    expect(said).toHaveLength(2);
  });

  it('a hook that refuses the resumed run: no model runs, the thread says why, it stays suspended', async () => {
    await task(ana, 'Paused one');
    const run = await tidy(ana, 'Paused one');
    seen.refuse = true;
    try {
      await ana.call('POST', `/api/approvals/${run.approvalId}/approve`);
      const next = await continuation(ana, run.threadId, run.runId, 1);
      expect(textOfMessage(next)).toBe('Paused for the test.');
      expect(next.parts).toEqual([{ type: 'text', text: 'Paused for the test.' }]);
    } finally {
      seen.refuse = false;
    }
    expect(
      await runtime().agents.findSuspension({ runId: run.runId, approvalId: run.approvalId }),
    ).toMatchObject({ runId: run.runId });
  });

  it("the app's stream shows the parked call's card and the waiting line, and ends", async () => {
    await task(ana, 'Streamed one');
    const res = await ana.stream('tidy Streamed one');
    expect(res.status).toBe(200);
    const types = res.events.map((e) => e.type);
    const output = res.events.find(
      (e) => e.type === 'tool-output-available' && JSON.stringify(e).includes('needs_approval'),
    ) as { output: { present?: { view?: string } } } | undefined;
    expect(output?.output.present?.view).toBe('approval.card');
    const said = res.events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e as { delta?: string }).delta)
      .join('');
    expect(said).toContain('I\'ve asked for your approval: Delete "Streamed one"');
    expect(types.at(-1)).toBe('finish');
    // The thread keeps the same: the card's part and the line.
    const runId = res.headers.get('x-run-id') ?? '';
    const saved = (await messages(ana, await threadOf(ana))).filter(
      (m) => m.metadata.runId === runId,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].parts.map((p) => p.type)).toEqual([
      'tool-list-tasks',
      'tool-delete-task',
      'text',
    ]);
  });

  it('another person never reads the thread it went on in', async () => {
    const threadId = await threadOf(ana);
    expect((await bob.call('GET', `/api/threads/${threadId}/messages`)).status).toBe(404);
    expect((await sam.call('GET', `/api/threads/${threadId}/messages`)).status).toBe(404);
  });

  it('a request made outside a chat turn resumes nothing', async () => {
    const t = await task(ana, 'Loose one');
    const runId = `r${Date.now()}loose`;
    const parked = await asAssistant(`user:${ana.id}`, { 'x-run-id': runId })(
      'DELETE',
      `/api/tasks/${t.id}`,
    );
    expect(parked.body.status).toBe('needs_approval');
    const before = (await messages(ana, await threadOf(ana))).length;
    await ana.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    await new Promise((r) => setTimeout(r, 2500));
    const { rows } = await pool.query(
      'select count(*)::int as n from app.thread_messages where run_id = $1',
      [runId],
    );
    expect(rows).toEqual([{ n: 0 }]);
    expect((await messages(ana, await threadOf(ana))).length).toBe(before);
  });
});
