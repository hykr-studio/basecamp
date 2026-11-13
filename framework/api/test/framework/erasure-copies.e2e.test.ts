// Erasure reaches every feature's copies (decisions V8): after a member and a WhatsApp contact
// are forgotten, nothing the server keeps, in any table of the database or any key of the run's
// queues in Redis, still holds their name, email, number or words. Seeded through the API as
// people use it: comments (theirs, and mentions of them), parties (by email and by number),
// share links naming them, a business memory, an agent with its run, an agent started by the
// contact's message, a job started for the member, another member's inbox and push log. Their
// copies (audit rows, events, replies, notifications) and Redis's finished jobs go with them,
// and a marker of another person stays where it was.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { AgentsService } from '../../dist/testing-internals.js';
import { privacyApp } from '../fixture/dist/features/privacy/index.js';

const stamp = Date.now().toString(36);
const MK = `v8sam${stamp}`; // in Sam's name, so in his email too
const M1 = `v8one${stamp}`; // Sam's comment
const M2 = `v8two${stamp}`; // Sam's business memory
const M3 = `v8three${stamp}`; // Sam's agent's instructions
const M4 = `v8four${stamp}`; // a job started for Sam
const WK = `v8wen${stamp}`; // the contact's name
const M5 = `v8five${stamp}`; // the contact's message
const KEEP = `v8keep${stamp}`; // Ana's own words: they stay
const NUMBER = `9198${String(Date.now()).slice(-8)}`;

const ana = new Person(`Ana ${KEEP}`); // owner
const sam = new Person(`Sam ${MK}`); // admin, forgotten at his own request
const carol = new Person('Carol Copies'); // admin: files the contact's erasure
let tenantId = '';
let contactId = '';
const here = { 'x-tenant-id': '' };
const call = (p: Person, method: string, path: string, body?: unknown) =>
  p.call(method, path, body, here);

const MARKERS = [MK, M1, M2, M3, M4, WK, M5, NUMBER];

/** Every row of every table, in every schema, that holds one of these texts. */
async function rowsHolding(texts: readonly string[]) {
  const tables = (
    await pool.query(
      `select table_schema as s, table_name as t from information_schema.tables
       where table_type = 'BASE TABLE'
         and table_schema not in ('pg_catalog', 'information_schema', 'drizzle')`,
    )
  ).rows as { s: string; t: string }[];
  const like = texts.map((t) => `%${t.toLowerCase()}%`);
  const out: { table: string; row: string }[] = [];
  for (const { s, t } of tables) {
    const { rows } = await pool.query(
      `select left(x::text, 300) as row from "${s}"."${t}" as x where lower(x::text) like any($1)`,
      [like],
    );
    for (const r of rows) out.push({ table: `${s}.${t}`, row: r.row });
  }
  return out;
}

/** Every key of this run's queues in Redis whose contents hold one of these texts. */
async function keysHolding(texts: readonly string[]) {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const prefix = process.env.BULL_PREFIX ?? 'bull';
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');
  const lower = texts.map((t) => t.toLowerCase());
  const out: string[] = [];
  for (const key of keys) {
    const type = await redis.type(key);
    let text = '';
    if (type === 'hash') text = JSON.stringify(await redis.hgetall(key));
    else if (type === 'string') text = (await redis.get(key)) ?? '';
    else if (type === 'list') text = JSON.stringify(await redis.lrange(key, 0, -1));
    else if (type === 'zset') text = JSON.stringify(await redis.zrange(key, 0, -1));
    else if (type === 'set') text = JSON.stringify(await redis.smembers(key));
    else if (type === 'stream') text = JSON.stringify(await redis.xrange(key, '-', '+'));
    const at = lower.map((m) => text.toLowerCase().indexOf(m)).find((i) => i >= 0);
    if (at !== undefined) out.push(`${key} ${text.slice(Math.max(0, at - 150), at + 60)}`);
  }
  redis.disconnect();
  return out;
}

const finished = (p: Person, id: string) =>
  eventually(async () => {
    const res = await call(p, 'GET', `/api/privacy/requests/${id}`);
    return ['completed', 'failed', 'refused'].includes(res.body?.status) ? res.body : undefined;
  }, 30_000);

/** No job of any queue is waiting, delayed or running. */
async function queuesIdle() {
  const { JobsService } = await import('../../dist/queues/jobs.service.js');
  const { queues } = await import('../../dist/hooks.js');
  const jobs = server.app?.get(JobsService, { strict: false });
  await eventually(async () => {
    for (const q of queues.all()) {
      const counts = await jobs.queue(q.name).getJobCounts('wait', 'delayed', 'active');
      if (counts.wait || counts.active || (counts.delayed && q.name === 'events')) return undefined;
    }
    return true;
  }, 30_000);
}

beforeAll(async () => {
  await boot(privacyApp);
  for (const p of [ana, sam, carol]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  here['x-tenant-id'] = tenantId;
  await setTenantSettings(tenantId, { privacy: null });
  // Sam's and Carol's only business is Ana's, so forgetting Sam forgets his login too.
  for (const p of [sam, carol]) {
    await pool.query(
      `update app.tenants set name = 'Elsewhere' where id in
         (select tenant_id from app.memberships where user_id = $1)`,
      [p.id],
    );
    await pool.query('delete from app.memberships where user_id = $1', [p.id]);
    await addMember(p, tenantId, ['admin']);
    await pool.query('update app.memberships set is_default = true where user_id = $1', [p.id]);
  }
  const wen = await seedContact(tenantId, `Wen ${WK}`, NUMBER);
  contactId = wen.contactId;
});

afterAll(shutdown);

describe('erasing a member and a contact (decisions V8)', () => {
  let samOutcome: Json = {};
  let wenOutcome: Json = {};

  beforeAll(async () => {
    // 1. Sam comments on a task; Ana names him in a comment on hers.
    const samTask = await call(sam, 'POST', '/api/tasks', { title: 'Sam task' });
    expect(samTask.status).toBeLessThan(300);
    const said = await call(sam, 'POST', '/api/comments', {
      entity: 'task',
      recordId: samTask.body.value.id,
      body: `@[${carol.name}](user:${carol.id}) ${M1} is what I think`,
    });
    expect(said.status, JSON.stringify(said.body)).toBeLessThan(300);
    const commentId = said.body.value.id as string;
    // Carol finds it in her inbox; a push to her phone keeps the comment for its next channel.
    await eventually(async () => {
      const { rows } = await pool.query(
        'select id from channel.inbox_items where user_id = $1 and body like $2',
        [carol.id, `%${M1}%`],
      );
      return rows.length ? true : undefined;
    }, 20_000);
    await pool.query(
      `insert into channel.push_tickets (tenant_id, user_id, send_id, token, notification, dedupe,
         meta, status)
       values ($1, $2, $3, 'ExponentPushToken[v8]', 'comment.mention', $4, $5, 'ok')`,
      [
        tenantId,
        carol.id,
        randomUUID(),
        `comment.mention:${commentId}:${carol.id}`,
        { row: { id: commentId, body: `${M1} is what I think`, author: { name: sam.name } } },
      ],
    );
    const anaTask = await call(ana, 'POST', '/api/tasks', { title: `${KEEP} task` });
    const named = await call(ana, 'POST', '/api/comments', {
      entity: 'task',
      recordId: anaTask.body.value.id,
      body: `@[${sam.name}](user:${sam.id}) please look`,
    });
    expect(named.status, JSON.stringify(named.body)).toBeLessThan(300);

    // 2. Ana puts Sam on a party by his email, and the contact on another by number.
    const party = await call(ana, 'POST', '/api/parties', { kind: 'organisation', name: KEEP });
    expect(party.status, JSON.stringify(party.body)).toBeLessThan(300);
    const byEmail = await call(ana, 'POST', `/api/parties/${party.body.value.id}/members`, {
      email: sam.email,
    });
    expect(byEmail.status, JSON.stringify(byEmail.body)).toBeLessThan(300);
    const person = await call(ana, 'POST', '/api/parties', { kind: 'person', name: `Wen ${WK}` });
    const byNumber = await call(ana, 'POST', `/api/parties/${person.body.value.id}/members`, {
      address: NUMBER,
      name: `Wen ${WK}`,
    });
    expect(byNumber.status, JSON.stringify(byNumber.body)).toBeLessThan(300);

    // 3. Links naming Sam's email and the contact, with labels that name them.
    const page = await call(ana, 'POST', '/api/pages', {
      name: `${KEEP} page`,
      spec: {
        title: `${KEEP} page`,
        layout: 'stack',
        blocks: [{ id: 'k', view: 'kpi.row', props: { items: [{ label: 'Open', value: 3 }] } }],
      },
    });
    expect(page.status).toBeLessThan(300);
    for (const [to, label] of [
      [{ email: sam.email }, `For ${MK}`],
      [{ contactId }, `For ${WK}`],
    ] as const) {
      const link = await call(ana, 'POST', '/api/shares', {
        target: { page: page.body.value.id },
        to,
        label,
      });
      expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
    }

    // 4. Sam writes a business memory.
    const memory = await call(sam, 'POST', '/api/memories', { text: `${M2} is how we work` });
    expect(memory.status, JSON.stringify(memory.body)).toBeLessThan(300);

    // 5. Sam makes an agent and runs it once.
    const agent = await call(sam, 'POST', '/api/agents', {
      name: 'Helper',
      instructions: `Say ${M3} and nothing else.`,
    });
    expect(agent.status, JSON.stringify(agent.body)).toBeLessThan(300);
    const run = await call(sam, 'POST', `/api/agents/${agent.body.value.id}/run`, {});
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    await eventually(async () => {
      const r = await call(sam, 'GET', `/api/agent-runs/${run.body.value.id}`);
      return ['done', 'failed', 'refused'].includes(r.body?.status) ? true : undefined;
    }, 20_000);

    // 6. The contact's message starts Ana's agent.
    const listener = await call(ana, 'POST', '/api/agents', {
      name: 'Listener',
      instructions: 'Report what started this run.',
      triggers: [{ kind: 'message', contains: ['ready'] }],
    });
    expect(listener.status, JSON.stringify(listener.body)).toBeLessThan(300);
    const agents = server.app?.get(AgentsService, { strict: false });
    expect(
      await agents.onInbound({
        tenantId,
        contactId,
        message: {
          providerMessageId: `wamid.${randomUUID()}`,
          to: '1',
          from: NUMBER,
          profileName: `Wen ${WK}`,
          at: new Date(),
          body: { kind: 'text', text: `Is ${M5} ready?` },
        },
      }),
    ).toBe(1);
    await eventually(async () => {
      const { rows } = await pool.query(
        `select status from app.agent_runs where agent_id = $1 and status in ('done', 'failed')`,
        [listener.body.value.id],
      );
      return rows.length ? true : undefined;
    }, 20_000);

    // 7. A job about no record started for Sam, with a result file and its upload's audit row.
    const job = await pool.query(
      `insert into app.jobs (tenant_id, kind, started_for, started_by_kind, started_by_id, input,
         message, status, deadline_at)
       values ($1, 'fixture.v8', $2, 'user', $3, $4, $5, 'succeeded', now() + interval '1 day')
       returning id`,
      [tenantId, `user:${sam.id}`, sam.id, { note: M4 }, `${M4} done`],
    );
    const jobId = job.rows[0].id as string;
    const resultFile = await pool.query(
      `insert into app.files (tenant_id, owner_id, key, name, mime, size, status, resource_type,
         resource_id, field)
       values ($1, $2, $3, $4, 'text/csv', 10, 'attached', 'job', $5, 'result') returning id`,
      [tenantId, sam.id, `v8/${randomUUID()}`, `${M4}.csv`, jobId],
    );
    await pool.query(
      `insert into audit.events (action, resource_type, resource_id, actor_kind, actor_id,
         tenant_id, outcome, after)
       values ('file.attach', 'file', $1, 'system', 'jobs', $2, 'committed', $3),
              ('job.start', 'job', $4, 'user', $5, $2, 'committed', $6)`,
      [
        resultFile.rows[0].id,
        tenantId,
        { name: `${M4}.csv`, on: { entity: 'job', id: jobId } },
        jobId,
        sam.id,
        { id: jobId, input: { note: M4 }, message: `${M4} done` },
      ],
    );

    await queuesIdle();
    expect((await rowsHolding([M1, M2, M3, M4, M5])).length).toBeGreaterThan(5);
    expect((await keysHolding([MK, M1])).length).toBeGreaterThan(0);

    // Sam asks to be forgotten; Carol files the contact's erasure, and Ana approves it.
    const asked = await call(sam, 'POST', '/api/privacy/requests', { kind: 'erase' });
    expect(asked.status, JSON.stringify(asked.body)).toBeLessThan(300);
    samOutcome = await finished(ana, asked.body.value.id);
    expect(samOutcome.status, JSON.stringify(samOutcome)).toBe('completed');
    const filed = await call(carol, 'POST', '/api/privacy/requests', {
      kind: 'erase',
      for: { contactId },
      intake: 'post',
    });
    expect(filed.body.status, JSON.stringify(filed.body)).toBe('needs_approval');
    const approved = await call(ana, 'POST', `/api/approvals/${filed.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    wenOutcome = await eventually(async () => {
      const list = await call(carol, 'GET', '/api/privacy/requests?kind=erase');
      return list.body.items.find(
        (r: Json) => r.subject.id === contactId && ['completed', 'failed'].includes(r.status),
      );
    }, 30_000);
    expect(wenOutcome.status, JSON.stringify(wenOutcome)).toBe('completed');
    await queuesIdle();
  }, 120_000);

  it('leaves no row in the database holding their name, email, number or words', async () => {
    expect(await rowsHolding(MARKERS)).toEqual([]);
  });

  it('leaves no job in Redis holding them', async () => {
    expect(await keysHolding(MARKERS)).toEqual([]);
  });

  it("keeps everyone else's words", async () => {
    expect((await rowsHolding([KEEP])).length).toBeGreaterThan(0);
  });
});

describe("a job's files: kept on erasure, until their period (decisions V8)", () => {
  it('are on the register as kept, and go once the job is older than the period', async () => {
    const reg = (await call(ana, 'GET', '/api/privacy/register')).body;
    expect(reg.parts.find((x: Json) => x.name === 'jobs.files')).toMatchObject({
      erase: 'keep',
      keepReason: 'business_copy',
    });
    expect(reg.retention.map((r: Json) => r.name)).toContain('jobs.files');
    const NAME = `v8export${stamp}`;
    const job = async (days: number) => {
      const made = await pool.query(
        `insert into app.jobs (tenant_id, kind, started_for, started_by_kind, started_by_id,
           input, status, deadline_at, finished_at)
         values ($1, 'fixture.v8', $2, 'user', $3, '{}', 'succeeded', now(),
           now() - make_interval(days => $4)) returning id`,
        [tenantId, `user:${ana.id}`, ana.id, days],
      );
      const id = made.rows[0].id as string;
      const f = await pool.query(
        `insert into app.files (tenant_id, owner_id, key, name, mime, size, status, resource_type,
           resource_id, field)
         values ($1, $2, $3, $4, 'application/zip', 10, 'attached', 'job', $5, 'result')
         returning id`,
        [tenantId, ana.id, `v8/${randomUUID()}`, `${NAME}-${days}.zip`, id],
      );
      await pool.query(
        `insert into audit.events (action, resource_type, resource_id, actor_kind, actor_id,
           tenant_id, outcome, after)
         values ('file.attach', 'file', $1, 'system', 'jobs', $2, 'committed', $3)`,
        [f.rows[0].id, tenantId, { name: `${NAME}-${days}.zip`, on: { entity: 'job', id } }],
      );
      return f.rows[0].id as string;
    };
    const old = await job(40);
    const recent = await job(1);
    await setTenantSettings(tenantId, { privacy: { retention: { 'jobs.files': 30 } } });
    const { PrivacyService } = await import('../../dist/index.js');
    const privacy = server.app?.get(PrivacyService, { strict: false });
    expect(await privacy.runRetention({ tenantId })).toMatchObject({ 'jobs.files': 1 });
    const status = async (id: string) =>
      (await pool.query('select status, name from app.files where id = $1', [id])).rows[0];
    expect(await status(old)).toEqual({ status: 'erased', name: 'erased' });
    expect((await status(recent)).status).toBe('attached');
    expect((await rowsHolding([`${NAME}-40`])).map((r) => r.table)).toEqual([]);
    expect((await rowsHolding([`${NAME}-1`])).length).toBeGreaterThan(0);
  });
});
