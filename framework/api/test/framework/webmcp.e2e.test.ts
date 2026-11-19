// A page's WebMCP tools (A2): the browser runs the assistant's read tools through the API client
// with the person's session cookie and `x-channel: webmcp`. The tools here are the real ones
// (`entityReadTools`, `runReadTool`), run against the fixture app: the person's business and
// access apply, hidden fields stay hidden, and the channel only reads and never acts as a
// person (people-only routes, approvals, chat turns). The fixture's `webmcp` feature adds a
// staff projector and a people-only `memo` entity.
import { createApiClient, runReadTool } from '@hykr/api-client';
import { entityReadTools, type ReadToolDef } from '@hykr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  origin,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { TaskSpec } from '../fixture/dist/contracts.js';
import { MemoSpec, webMcpServer } from '../fixture/dist/features/webmcp/index.js';

const owner = new Person('Owner Pages');
const staff = new Person('Staff Pages');
const stranger = new Person('Stranger Pages');
let tenantId = '';
const WEBMCP = { 'x-channel': 'webmcp' };

/** The page's client: the person's cookie, their business, and the WebMCP channel. */
const pageClient = (person: Person, tenant?: string) =>
  createApiClient({
    baseUrl: server.base,
    headers: () => ({
      origin,
      cookie: person.cookie,
      ...(tenant ? { 'x-tenant-id': tenant } : {}),
      ...WEBMCP,
    }),
  });

const [listTasks, getTask] = entityReadTools(TaskSpec) as [ReadToolDef, ReadToolDef];

type Row = { id: string; title: string; dueOn?: string | null };
const rowsOf = (out: unknown) => (out as { result: { items: Row[] } }).result.items;

const auditCount = async (person: Person) =>
  Number(
    (await pool.query('select count(*) from audit.events where actor_id = $1', [person.id])).rows[0]
      .count,
  );

let ownTask = '';
let staffTask = '';
let strangerTask = '';

beforeAll(async () => {
  await boot(webMcpServer);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  ownTask = (await owner.call('POST', '/api/tasks', { title: 'Order tiles', dueOn: '2030-02-01' }))
    .body.value.id;
  staffTask = (
    await staff.call(
      'POST',
      '/api/tasks',
      { title: 'Measure the hall', dueOn: '2030-03-01' },
      { 'x-tenant-id': tenantId },
    )
  ).body.value.id;
  strangerTask = (await stranger.call('POST', '/api/tasks', { title: 'Someone else’s' })).body.value
    .id;
});
afterAll(shutdown);

describe('the read tools on the WebMCP channel', () => {
  it('are the assistant’s list and get, and an entity closed to agents offers none', () => {
    expect([listTasks.id, getTask.id]).toEqual(['list-tasks', 'get-task']);
    expect(entityReadTools(MemoSpec)).toEqual([]);
  });

  it('list only the person’s business: another business’s rows are not there', async () => {
    const out = await runReadTool(pageClient(owner), listTasks, {});
    expect(out.ok).toBe(true);
    const ids = rowsOf(out).map((r) => r.id);
    expect(ids).toContain(ownTask);
    expect(ids).not.toContain(strangerTask);
    const theirs = await runReadTool(pageClient(stranger), listTasks, { title: 'Order tiles' });
    expect(rowsOf(theirs)).toEqual([]);
  });

  it('get another business’s record as a 404, never its data', async () => {
    const out = await runReadTool(pageClient(stranger), getTask, { id: ownTask });
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(JSON.stringify(out)).not.toContain('Order tiles');
    // The person's own record, through the same tool.
    const mine = await runReadTool(pageClient(owner), getTask, { id: ownTask });
    expect(mine).toMatchObject({ ok: true, result: { id: ownTask, dueOn: '2030-02-01' } });
  });

  it('keep a field hidden from a role hidden, in a list and in a get', async () => {
    const client = pageClient(staff, tenantId);
    const listed = rowsOf(await runReadTool(client, listTasks, {}));
    expect(listed.map((r) => r.id)).toEqual([staffTask]); // staff reach their own rows
    expect(listed[0]).not.toHaveProperty('dueOn');
    const got = await runReadTool(client, getTask, { id: staffTask });
    expect(got).toMatchObject({ ok: true, result: { title: 'Measure the hall' } });
    expect((got as { result: object }).result).not.toHaveProperty('dueOn');
    // The date is there: the owner's own task shows it (the test above), and the database has it.
    const { rows } = await pool.query(
      'select due_on::text as due_on from app.fixture_tasks where id = $1',
      [staffTask],
    );
    expect(rows[0].due_on).toBe('2030-03-01');
  });

  it('send nothing for an input the tool refuses', async () => {
    expect(await runReadTool(pageClient(owner), listTasks, { owner: 'me' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });
});

describe('the WebMCP channel on the server', () => {
  it('refuses every write, command, decision and turn before it runs: nothing written, parked or audited', async () => {
    const before = await auditCount(owner);
    const visit = await owner.call('POST', '/api/visits', {
      title: 'Walkthrough',
      startsAt: '2030-01-01T10:00:00.000Z',
      endsAt: '2030-01-01T11:00:00.000Z',
    });
    const visitId = visit.body.value.id;
    const parked = await asAssistant(`user:${owner.id}`, { 'x-channel': 'app' })(
      'DELETE',
      `/api/tasks/${ownTask}`,
    );
    expect(parked.body).toMatchObject({ status: 'needs_approval' });
    const approvalId = parked.body.approval.id;
    const audited = await auditCount(owner);
    expect(audited).toBe(before + 1); // the visit; the park is the assistant's

    const attempts: [string, string, unknown?][] = [
      ['POST', '/api/tasks', { title: 'From the page' }],
      ['PATCH', `/api/tasks/${ownTask}`, { title: 'Renamed by the page' }],
      ['DELETE', `/api/tasks/${ownTask}`],
      [
        'POST',
        `/api/visits/${visitId}/reschedule`,
        { startsAt: '2030-01-02T10:00:00.000Z', endsAt: '2030-01-02T11:00:00.000Z' },
      ],
      ['POST', `/api/approvals/${approvalId}/approve`],
      ['POST', '/api/chat/once', { message: 'add Order tiles' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await owner.call(method, path, body, WEBMCP);
      expect({ method, path, status: res.status, body: res.body }).toMatchObject({
        status: 403,
        body: { rule: 'read_only_channel' },
      });
    }
    // Nothing changed: the task, the visit, the approval; no audit row for the attempts.
    const task = await owner.call('GET', `/api/tasks/${ownTask}`);
    expect(task.body.title).toBe('Order tiles');
    const moved = await owner.call('GET', `/api/visits/${visitId}`);
    expect(moved.body.startsAt).toBe('2030-01-01T10:00:00.000Z');
    const { rows } = await pool.query('select status from app.approvals where id = $1', [
      approvalId,
    ]);
    expect(rows[0].status).toBe('pending');
    const { rows: tasks } = await pool.query(
      "select count(*) from app.fixture_tasks where title = 'From the page'",
    );
    expect(Number(tasks[0].count)).toBe(0);
    expect(await auditCount(owner)).toBe(audited);
  });

  it('keeps people-only routes for people: an expose human list or get, the approvals', async () => {
    const memo = await owner.call('POST', '/api/memos', { title: 'Only for people' });
    expect(memo.status).toBe(201);
    const id = memo.body.value.id;
    for (const path of ['/api/memos', `/api/memos/${id}`, '/api/approvals']) {
      const res = await owner.call('GET', path, undefined, WEBMCP);
      expect({ path, status: res.status, body: res.body }).toMatchObject({
        status: 403,
        body: { rule: 'humans_only' },
      });
      // The same session, without the channel, is the person.
      expect((await owner.call('GET', path)).status).toBe(200);
    }
  });

  it('lets the same session write without the header, and records the app channel it names', async () => {
    const plain = await owner.call('PATCH', `/api/tasks/${ownTask}`, { done: true });
    expect(plain.status).toBe(200);
    const named = await owner.call(
      'PATCH',
      `/api/tasks/${ownTask}`,
      { done: false },
      { 'x-channel': 'app' },
    );
    expect(named.status).toBe(200);
    const { rows } = await pool.query(
      `select channel from audit.events where resource_id = $1 and action = 'task.update'
       order by at`,
      [ownTask],
    );
    expect(rows.map((r) => r.channel)).toEqual([null, 'app']);
  });

  it('refuses a channel a session cannot name', async () => {
    for (const channel of ['whatsapp', 'background', 'share', 'mcp', 'WEBMCP', 'anything']) {
      const res = await owner.call('GET', '/api/tasks', undefined, { 'x-channel': channel });
      expect({ channel, status: res.status, body: res.body }).toMatchObject({
        status: 400,
        body: { error: 'bad_channel' },
      });
    }
  });

  it('leaves agents as they were: the assistant still forwards its turn channel', async () => {
    const res = await asAssistant(`user:${owner.id}`, { 'x-channel': 'app' })('GET', '/api/tasks');
    expect(res.status).toBe(200);
  });
});
