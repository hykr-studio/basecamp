// Long-running jobs (B11), against the fixture's `drawings` module (fixture/src/features/jobs)
// and a stand-in outside service run here: started by a command (the assistant's start waits for
// approval), submitted by the worker, moved on by signed callbacks or by polling, finished with
// result files kept on the job and written back by `complete`; another business gets 404, staff
// never see a render's cost, deadlines, cancelling, live updates and personal data.
import { createServer, type Server } from 'node:http';
import { type LiveMessage, liveMessages, textOf } from '@hykr/api-client';
import type { Principal } from '@hykr/contracts';
import { eventFor, toEnvelope } from '@hykr/core';
import { domainEvents } from '@hykr/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The API's entry is loaded in beforeAll, once the stand-in's address is in the environment.
type Api = typeof import('../../dist/index.js');
let api: Api;

import {
  addMember,
  asAssistant,
  boot,
  eventually,
  type Json,
  me,
  origin,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { jobsApp } from '../fixture/dist/features/jobs/index.js';

const owner = new Person('Owner Jobs');
const staff = new Person('Staff Jobs');
const stranger = new Person('Stranger Jobs');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

/* ── Bytes ─────────────────────────────────────────────────────────────────── */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A PNG's signature and header: enough for its type and size to be read. */
const png = (width = 320, height = 200) =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    u32(13),
    Buffer.from('IHDR'),
    u32(width),
    u32(height),
    Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(64, 7),
  ]);

/* ── The stand-in outside service ──────────────────────────────────────────── */

type Submission = {
  id: string;
  job: string;
  kind: string;
  input: Json;
  source: string | null;
  callback: { url: string; secret: string; header: string } | null;
};
const stand = {
  submissions: [] as Submission[],
  cancelled: [] as string[],
  files: new Map<string, Buffer>(),
  /** What a poll answers, by the service's id. */
  status: new Map<string, unknown>(),
  /** Refuse this many submissions (503). */
  refuse: 0,
};
let standServer: Server;
let standUrl = '';
let seq = 0;

async function readBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

function startStand() {
  standServer = createServer(async (req, res) => {
    const url = req.url ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url === '/submit') {
      const body = await readBody(req);
      if (stand.refuse > 0) {
        stand.refuse -= 1;
        return json(503, { error: 'busy' });
      }
      const id = `ext-${++seq}`;
      stand.submissions.push({ id, ...body });
      return json(200, { id });
    }
    if (req.method === 'POST' && url.startsWith('/cancel/')) {
      stand.cancelled.push(url.slice('/cancel/'.length));
      return json(200, {});
    }
    if (req.method === 'GET' && url.startsWith('/status/'))
      return json(200, { update: stand.status.get(url.slice('/status/'.length)) ?? null });
    if (req.method === 'GET' && url.startsWith('/files/')) {
      const bytes = stand.files.get(url.slice('/files/'.length));
      if (!bytes) return json(404, {});
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
      return res.end(bytes);
    }
    json(404, {});
  });
  return new Promise<void>((resolve) =>
    standServer.listen(0, '127.0.0.1', () => {
      const address = standServer.address();
      standUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    }),
  );
}

/** The stand-in's submission of this job. */
const submitted = (jobId: string) =>
  eventually(() => stand.submissions.find((s) => s.job === jobId));

/** Post an update as the service would, signed with the job's secret (or as told). */
async function post(
  jobId: string,
  update: unknown,
  o: { secret?: string; t?: number; header?: string | null; raw?: string } = {},
) {
  const raw = o.raw ?? JSON.stringify(update);
  const secret = o.secret ?? (await submitted(jobId)).callback?.secret ?? '';
  const header =
    o.header === null ? undefined : (o.header ?? api.signJobCallback(secret, raw, o.t));
  const res = await fetch(`${server.base}/api/jobs/${jobId}/callback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(header ? { 'x-job-signature': header } : {}),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const runner = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(api.JobRunner, { strict: false });
};

const drawing = async (title: string) =>
  (await owner.call('POST', '/api/drawings', { title })).body.value as Json;

const render = (person: Person, drawingId: string, headers: Record<string, string> = {}) =>
  person.call('POST', `/api/drawings/${drawingId}/render`, { quality: 'draft' }, headers);

const job = (person: Person, id: string, headers: Record<string, string> = {}) =>
  person.call('GET', `/api/jobs/${id}`, undefined, headers);

/** Wait until the owner sees the job in this state. */
const until = (id: string, check: (j: Json) => boolean, ms?: number) =>
  eventually(async () => {
    const j = (await job(owner, id)).body;
    return check(j) ? j : undefined;
  }, ms);

const running = async (drawingId: string) => {
  const started = await render(owner, drawingId);
  expect(started.body.status).toBe('done');
  const id = started.body.value.id as string;
  await until(id, (j) => j.status === 'running');
  return id;
};

const audit = async (resourceId: string, action?: string) =>
  (
    await pool.query(
      `select action, outcome, actor_kind, actor_id, channel, after from audit.events
       where resource_id = $1 ${action ? 'and action = $2' : ''} order by at`,
      action ? [resourceId, action] : [resourceId],
    )
  ).rows;

const events = async (jobId: string) =>
  (
    await pool.query(
      'select name from app.domain_events where resource_type = $1 and resource_id = $2 order by seq',
      ['job', jobId],
    )
  ).rows.map((r) => r.name as string);

const updateOutcomes = async (jobId: string) =>
  (
    await pool.query('select outcome from app.job_updates where job_id = $1 order by received_at', [
      jobId,
    ])
  ).rows.map((r) => r.outcome as string | null);

beforeAll(async () => {
  await startStand();
  process.env.FIXTURE_JOBS_URL = standUrl;
  api = await import('../../dist/index.js');
  await boot(jobsApp);
  process.env.JOBS_PUBLIC_URL = server.base;
  await owner.signUp();
  await staff.signUp();
  await stranger.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
});

afterAll(async () => {
  await shutdown();
  await new Promise((r) => standServer.close(r));
});

describe('a job started by a command, submitted by the worker', () => {
  it('is queued in the write, audited, and its event stored', async () => {
    const d = await drawing('Plan A');
    const started = await render(owner, d.id);
    expect(started.body).toMatchObject({
      status: 'done',
      value: { kind: 'fixture.render', status: 'queued', about: { entity: 'drawing', id: d.id } },
    });
    const id = started.body.value.id as string;
    expect(await audit(id, 'job.start')).toEqual([
      expect.objectContaining({ actor_kind: 'user', actor_id: owner.id, outcome: 'committed' }),
    ]);
    expect((await events(id))[0]).toBe('job.queued');
  });

  it('is handed to its service with its own callback URL and secret, then runs', async () => {
    const d = await drawing('Plan B');
    const id = (await render(owner, d.id)).body.value.id as string;
    const s = await submitted(id);
    expect(s.kind).toBe('fixture.render');
    expect(s.input).toEqual({ drawingId: d.id, quality: 'draft' });
    expect(s.callback).toEqual({
      url: `${server.base}/api/jobs/${id}/callback`,
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
      header: 'x-job-signature',
    });
    const j = await until(id, (x) => x.status === 'running');
    expect(j.submittedAt).toEqual(expect.any(String));
    expect(await audit(id, 'job.submit')).toEqual([
      expect.objectContaining({ actor_kind: 'system', actor_id: 'fixture.render' }),
    ]);
    expect(await events(id)).toEqual(['job.queued', 'job.running']);
    // Never shown: the service's id, the secret, the lease.
    const text = JSON.stringify(j);
    expect(text).not.toContain(s.id);
    expect(text).not.toContain(s.callback?.secret);
    expect(j).not.toHaveProperty('externalId');
    expect(j).not.toHaveProperty('leaseUntil');
  });

  it('a submission that fails is tried again, then fails the job', async () => {
    stand.refuse = 2;
    const d = await drawing('Plan Busy');
    const id = (await render(owner, d.id)).body.value.id as string;
    const j = await until(id, (x) => x.status === 'failed', 15_000);
    expect(j.error).toEqual({ code: 'submit_failed', message: 'The service answered 503' });
    const { rows } = await pool.query('select attempts from app.jobs where id = $1', [id]);
    expect(rows[0].attempts).toBe(2);
  });
});

describe('callbacks', () => {
  it('signed progress moves it on, one event per step; a lower percentage changes nothing', async () => {
    const id = await running((await drawing('Plan C')).id);
    expect((await post(id, { status: 'running', progress: 30, message: 'Lighting' })).status).toBe(
      202,
    );
    await until(id, (j) => j.progress === 30 && j.message === 'Lighting');
    expect((await post(id, { status: 'running', progress: 20 })).status).toBe(202);
    await eventually(async () => (await updateOutcomes(id)).includes('ignored: lower'));
    expect((await job(owner, id)).body.progress).toBe(30);
    await post(id, { status: 'running', progress: 60.7 });
    await until(id, (j) => j.progress === 60);
    expect(await events(id)).toEqual(['job.queued', 'job.running', 'job.progress', 'job.progress']);
  });

  it('a bad, tampered, stale or missing signature, or another job’s secret: 401', async () => {
    const id = await running((await drawing('Plan D')).id);
    const other = await running((await drawing('Plan E')).id);
    const update = { status: 'running', progress: 50 };
    expect((await post(id, update, { secret: 'f'.repeat(64) })).status).toBe(401);
    expect(
      (await post(id, update, { secret: (await submitted(other)).callback?.secret })).status,
    ).toBe(401);
    const secret = (await submitted(id)).callback?.secret ?? '';
    const raw = JSON.stringify(update);
    expect(
      (
        await post(id, update, {
          raw: JSON.stringify({ ...update, progress: 99 }),
          header: api.signJobCallback(secret, raw),
        })
      ).status,
    ).toBe(401);
    expect((await post(id, update, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await post(id, update, { header: null })).status).toBe(401);
    expect((await job(owner, id)).body.progress).toBeNull();
  });

  it('an unknown job is 404; a body that is no update is 400', async () => {
    const id = await running((await drawing('Plan F')).id);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await post(unknown, { status: 'running' }, { secret: 'x' })).status).toBe(404);
    const res = await fetch(`${server.base}/api/jobs/not-a-job/callback`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await post(id, { status: 'done' })).status).toBe(400);
  });

  it('a repeat is kept once and applied once', async () => {
    const id = await running((await drawing('Plan G')).id);
    const raw = JSON.stringify({ status: 'running', progress: 10, message: 'Once' });
    const secret = (await submitted(id)).callback?.secret ?? '';
    const header = api.signJobCallback(secret, raw);
    expect((await post(id, null, { raw, header })).status).toBe(202);
    expect(await post(id, null, { raw, header })).toEqual({
      status: 200,
      body: { received: true, duplicate: true },
    });
    await until(id, (j) => j.progress === 10);
    const { rows } = await pool.query(
      'select count(*)::int as n from app.job_updates where job_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('results', () => {
  let jobId = '';
  let drawingId = '';
  let files: string[] = [];

  it('a success with an inline file and one by URL: both kept on the job', async () => {
    const d = await drawing('Plan H');
    drawingId = d.id;
    jobId = await running(d.id);
    stand.files.set('page-2.png', png(640, 400));
    const res = await post(jobId, {
      status: 'succeeded',
      message: 'Rendered',
      output: { pages: 2, cost: 12.5 },
      files: [
        { name: 'page-1.png', mime: 'image/png', data: png().toString('base64') },
        { name: 'page-2.png', mime: 'image/png', url: `${standUrl}/files/page-2.png` },
      ],
    });
    expect(res.status).toBe(202);
    const j = await until(jobId, (x) => x.status === 'succeeded');
    expect(j).toMatchObject({
      progress: 100,
      message: 'Rendered',
      output: { pages: 2, cost: 12.5 },
    });
    expect(j.files).toHaveLength(2);
    files = j.files;
    const { rows } = await pool.query(
      'select resource_type, resource_id, field, source, status, width from app.files where id = any($1) order by name',
      [files],
    );
    expect(rows).toEqual([
      {
        resource_type: 'job',
        resource_id: jobId,
        field: 'results',
        source: 'server',
        status: 'ready',
        width: 320,
      },
      {
        resource_type: 'job',
        resource_id: jobId,
        field: 'results',
        source: 'server',
        status: 'ready',
        width: 640,
      },
    ]);
    expect(await audit(jobId, 'job.succeeded')).toEqual([
      expect.objectContaining({ actor_kind: 'system', actor_id: 'fixture.render' }),
    ]);
    // Inline bytes are not kept in the update once applied.
    const kept = await pool.query(
      'select body from app.job_updates where job_id = $1 and status = $2',
      [jobId, 'succeeded'],
    );
    expect(JSON.stringify(kept.rows[0].body)).not.toContain(png().toString('base64'));
  });

  it('whoever reads the drawing reaches the files, through the job', async () => {
    const mine = await owner.call('GET', `/api/files/${files[0]}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ attachedTo: { entity: 'job', id: jobId, field: 'results' } });
    const bytes = await fetch(`${server.base}${mine.body.url}`);
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(png());
    expect((await staff.call('GET', `/api/files/${files[1]}`, undefined, inTenant())).status).toBe(
      200,
    );
    const many = await staff.call(
      'GET',
      `/api/files?ids=${files.join(',')}`,
      undefined,
      inTenant(),
    );
    expect(many.body.items).toHaveLength(2);
  });

  it('complete puts a copy of the first page on the drawing, as the system', async () => {
    const d = await eventually(async () => {
      const x = (await owner.call('GET', `/api/drawings/${drawingId}`)).body;
      return x.pages === 2 && x.preview ? x : undefined;
    });
    expect(files).not.toContain(d.preview);
    const preview = await owner.call('GET', `/api/files/${d.preview}`);
    expect(preview.body).toMatchObject({
      name: 'page-1.png',
      attachedTo: { entity: 'drawing', id: drawingId, field: 'preview' },
    });
    expect(await audit(drawingId, 'drawing.update')).toEqual([
      expect.objectContaining({
        actor_kind: 'system',
        actor_id: 'fixture.render',
        channel: 'background',
      }),
    ]);
    const { rows } = await pool.query(
      'select completion, completion_attempts from app.jobs where id = $1',
      [jobId],
    );
    expect(rows[0]).toEqual({ completion: 'done', completion_attempts: 1 });
  });

  it('a result file cannot be put on a record', async () => {
    const d = await drawing('Plan Thief');
    const res = await owner.call('PATCH', `/api/drawings/${d.id}`, { preview: files[0] });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('file_unavailable');
  });

  it('a finished job changes no more: an update after is kept and answered "finished"', async () => {
    const res = await post(jobId, { status: 'failed', error: { message: 'Late' } });
    expect(res).toEqual({ status: 200, body: { received: true, finished: true } });
    expect((await job(owner, jobId)).body.status).toBe('succeeded');
  });

  it('an output that is not what the kind gives fails the job', async () => {
    const id = await running((await drawing('Plan I')).id);
    await post(id, { status: 'succeeded', output: { pages: 'two' } });
    const j = await until(id, (x) => x.status === 'failed');
    expect(j.error).toEqual({
      code: 'bad_output',
      message: 'The output is not what this job gives',
    });
    expect(await events(id)).toContain('job.failed');
  });

  it('a URL the kind does not fetch fails the job, once', async () => {
    const id = await running((await drawing('Plan J')).id);
    await post(id, {
      status: 'succeeded',
      output: { pages: 1 },
      files: [{ name: 'x.png', mime: 'image/png', url: 'https://example.test/x.png' }],
    });
    const j = await until(id, (x) => x.status === 'failed');
    expect(j.error.code).toBe('result_unavailable');
  });

  it('the service may fail or cancel it', async () => {
    const failed = await running((await drawing('Plan K')).id);
    await post(failed, {
      status: 'failed',
      error: { code: 'gpu_lost', message: 'The GPU went away' },
    });
    expect((await until(failed, (x) => x.status === 'failed')).error).toEqual({
      code: 'gpu_lost',
      message: 'The GPU went away',
    });
    const cancelled = await running((await drawing('Plan L')).id);
    await post(cancelled, { status: 'cancelled' });
    expect((await until(cancelled, (x) => x.status === 'cancelled')).error.code).toBe('cancelled');
  });
});

describe('who reaches a job', () => {
  let id = '';
  let drawingId = '';
  let fileId = '';

  beforeAll(async () => {
    const d = await drawing('Plan Reach');
    drawingId = d.id;
    id = await running(d.id);
    await post(id, {
      status: 'succeeded',
      output: { pages: 1, cost: 40 },
      files: [{ name: 'only.png', mime: 'image/png', data: png().toString('base64') }],
    });
    fileId = (await until(id, (x) => x.status === 'succeeded')).files[0];
  });

  it('another business: 404 for the job, its cancel and its files; never listed', async () => {
    expect((await job(stranger, id)).status).toBe(404);
    expect((await stranger.call('POST', `/api/jobs/${id}/cancel`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/files/${fileId}`)).status).toBe(404);
    const listed = await stranger.call('GET', `/api/jobs?entity=drawing&id=${drawingId}`);
    expect(listed.body.items).toEqual([]);
    expect((await stranger.call('GET', '/api/jobs')).body.items).toEqual([]);
    // Nor can it start one on our drawing.
    expect((await render(stranger, drawingId)).status).toBe(404);
  });

  it('a colleague who reads the drawing reaches it, and lists it', async () => {
    expect((await job(staff, id, inTenant())).status).toBe(200);
    const listed = await staff.call(
      'GET',
      `/api/jobs?entity=drawing&id=${drawingId}`,
      undefined,
      inTenant(),
    );
    expect(listed.body.items.map((j: Json) => j.id)).toContain(id);
    expect(
      (await staff.call('GET', '/api/jobs?entity=drawing', undefined, inTenant())).status,
    ).toBe(400);
  });

  it('staff never see what it cost: not in the job, the list or its event', async () => {
    expect((await job(owner, id)).body.output).toEqual({ pages: 1, cost: 40 });
    expect((await job(staff, id, inTenant())).body.output).toEqual({ pages: 1 });
    const listed = await staff.call(
      'GET',
      `/api/jobs?entity=drawing&id=${drawingId}`,
      undefined,
      inTenant(),
    );
    expect(listed.body.items.find((j: Json) => j.id === id).output).toEqual({ pages: 1 });
    const db = (await import('../../dist/infra/db.module.js')).DB;
    const conn = server.app?.get(db, { strict: false });
    const [row] = await conn
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.name, 'job.succeeded'))
      .then((rows: Json[]) => rows.filter((r) => r.resourceId === id));
    const asStaff: Principal = {
      actor: { kind: 'user', id: staff.id },
      subject: { kind: 'user', userId: staff.id },
      tenantId,
      roles: ['staff'],
      scopes: [],
    };
    const seen = eventFor(toEnvelope(row), asStaff) as Json;
    expect(seen.row.output).toEqual({ pages: 1 });
    expect(eventFor(toEnvelope(row), { ...asStaff, tenantId: 'elsewhere' })).toBeNull();
  });

  it('staff who may not change the drawing cannot cancel its job', async () => {
    const other = await running(drawingId);
    const res = await staff.call('POST', `/api/jobs/${other}/cancel`, undefined, inTenant());
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('job_not_yours');
  });
});

describe('the assistant', () => {
  it('starting a render waits for approval, audited; approved, it runs', async () => {
    const d = await drawing('Plan M');
    const said = await owner.chat(`render drawing ${d.id}`);
    expect(said.body.toolCalls.map((c: Json) => c.tool)).toEqual(['render-drawing']);
    expect(said.body.reply).toContain("I've asked for your approval");
    expect(await audit(d.id, 'drawing.render')).toEqual([
      expect.objectContaining({ actor_kind: 'agent', outcome: 'needs_approval' }),
    ]);
    expect((await owner.call('GET', `/api/jobs?entity=drawing&id=${d.id}`)).body.items).toEqual([]);
    const approvals = (await owner.call('GET', '/api/approvals')).body as Json[];
    const approval = approvals.find((a) => a.summary === 'Render "Plan M" (draft)');
    expect(approval).toBeDefined();
    expect((await owner.call('POST', `/api/approvals/${approval.id}/approve`)).status).toBe(200);
    const [started] = (await owner.call('GET', `/api/jobs?entity=drawing&id=${d.id}`)).body.items;
    expect(started).toMatchObject({ kind: 'fixture.render' });
    await submitted(started.id);
  });

  it('reads a job through its tools, but cannot cancel it', async () => {
    const id = await running((await drawing('Plan N')).id);
    await post(id, { status: 'running', progress: 45, message: 'Halfway' });
    await until(id, (j) => j.progress === 45);
    const said = await owner.chat(`how is job ${id}`);
    expect(said.body.toolCalls.map((c: Json) => c.tool)).toEqual(['get-job']);
    expect(said.body.reply).toBe('The job is running: 45% done (Halfway).');
    const list = await owner.chat('which jobs are running');
    expect(list.body.toolCalls.map((c: Json) => c.tool)).toEqual(['list-jobs']);
    expect(list.body.reply).toMatch(/^\d+ jobs? (is|are) running\.$/);
    const assistant = asAssistant(`user:${owner.id}`);
    expect((await assistant('GET', `/api/jobs/${id}`)).status).toBe(200);
    expect((await assistant('POST', `/api/jobs/${id}/cancel`)).status).toBe(403);
    // Another business's assistant finds nothing.
    expect((await stranger.chat(`how is job ${id}`)).body.reply).toContain(
      "I couldn't do that: No such job",
    );
  });
});

describe('a polled job about no record', () => {
  let id = '';

  it('is polled by the worker until it is done; it takes no callbacks', async () => {
    const started = await owner.call('POST', '/api/drawings/convert', { text: 'hello' });
    expect(started.body.value).toMatchObject({ kind: 'fixture.convert', about: null });
    id = started.body.value.id;
    const s = await submitted(id);
    expect(s.callback).toBeNull();
    expect((await post(id, { status: 'running' }, { secret: 'x' })).status).toBe(404);
    stand.status.set(s.id, { status: 'running', progress: 50 });
    await eventually(async () => {
      await runner().tick();
      return (await job(owner, id)).body.progress === 50;
    });
    stand.status.set(s.id, {
      status: 'succeeded',
      output: { text: 'HELLO' },
      files: [{ name: 'hello.png', mime: 'image/png', data: png().toString('base64') }],
    });
    const j = await eventually(async () => {
      await runner().tick();
      const x = (await job(owner, id)).body;
      return x.status === 'succeeded' ? x : undefined;
    });
    expect(j.output).toEqual({ text: 'HELLO' });
    expect((await owner.call('GET', `/api/files/${j.files[0]}`)).status).toBe(200);
  });

  it('only the person it was started for reaches it', async () => {
    const j = (await job(owner, id)).body;
    expect((await job(staff, id, inTenant())).status).toBe(404);
    expect(
      (await staff.call('GET', `/api/files/${j.files[0]}`, undefined, inTenant())).status,
    ).toBe(404);
    expect((await owner.call('GET', '/api/jobs')).body.items.map((x: Json) => x.id)).toContain(id);
    expect(
      (await staff.call('GET', '/api/jobs', undefined, inTenant())).body.items.map(
        (x: Json) => x.id,
      ),
    ).not.toContain(id);
  });

  it('its input file must be one the starter reaches, and its service gets the bytes', async () => {
    const upload = async (person: Person, headers: Record<string, string> = {}) => {
      const bytes = png(100, 100);
      const pre = await person.call(
        'POST',
        '/api/files',
        {
          name: 'in.png',
          mime: 'image/png',
          size: bytes.length,
          for: { entity: 'drawing', field: 'preview' },
        },
        headers,
      );
      await fetch(`${server.base}${pre.body.upload.url}`, {
        method: 'PUT',
        headers: pre.body.upload.headers,
        body: new Uint8Array(bytes),
      });
      await person.call('POST', `/api/files/${pre.body.file.id}/confirm`, undefined, headers);
      return pre.body.file.id as string;
    };
    const mine = await upload(owner);
    const started = await owner.call('POST', '/api/drawings/convert', {
      text: 'with file',
      source: mine,
    });
    const s = await submitted(started.body.value.id);
    expect(Buffer.from(s.source ?? '', 'base64')).toEqual(png(100, 100));

    const theirs = await upload(staff, inTenant());
    const refused = await owner.call('POST', '/api/drawings/convert', {
      text: 'not mine',
      source: theirs,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('file_unavailable');
    const { rows } = await pool.query(
      `select outcome from audit.events where action = 'drawing.convert' and actor_id = $1 order by at desc limit 1`,
      [owner.id],
    );
    expect(rows[0].outcome).toBe('denied');
  });

  it('a result URL to a private address fails it (the default download)', async () => {
    const started = await owner.call('POST', '/api/drawings/convert', { text: 'private' });
    const jid = started.body.value.id;
    const s = await submitted(jid);
    stand.status.set(s.id, {
      status: 'succeeded',
      files: [{ name: 'x.png', mime: 'image/png', url: `${standUrl}/files/page-2.png` }],
    });
    const j = await eventually(async () => {
      await runner().tick();
      const x = (await job(owner, jid)).body;
      return x.status === 'failed' ? x : undefined;
    });
    expect(j.error.code).toBe('result_unavailable');
    expect(j.error.message).toContain('https');
  });
});

describe('work done in the worker', () => {
  it('reports progress, reads as its starter, and keeps the file it made', async () => {
    const started = await owner.call('POST', '/api/drawings/export', { title: 'all' });
    const id = started.body.value.id as string;
    const j = await until(id, (x) => x.status === 'succeeded');
    expect(j).toMatchObject({ message: 'Written', progress: 100, about: null });
    expect(j.output.drawings).toBeGreaterThan(0);
    expect(await events(id)).toEqual([
      'job.queued',
      'job.running',
      'job.progress',
      'job.succeeded',
    ]);
    const file = await owner.call('GET', `/api/files/${j.files[0]}`);
    expect(file.body).toMatchObject({ name: 'all.csv', mime: 'text/csv' });
    const text = await (await fetch(`${server.base}${file.body.url}`)).text();
    expect(text).toContain('Plan A');
    // Only the runner names files a submission made: the stored update keeps their ids.
    const kept = await pool.query('select body from app.job_updates where job_id = $1', [id]);
    expect(kept.rows[0].body.madeFiles).toEqual(j.files);

    // Another business's export reads only its own drawings.
    const theirs = await stranger.call('POST', '/api/drawings/export', { title: 'mine' });
    const other = await eventually(async () => {
      const x = (await job(stranger, theirs.body.value.id)).body;
      return x.status === 'succeeded' ? x : undefined;
    });
    expect(other.output).toEqual({ drawings: 0 });
  });

  it('one that reported progress, then threw, is tried again and succeeds', async () => {
    const started = await owner.call('POST', '/api/drawings/export', {
      title: 'flaky',
      flaky: true,
    });
    const id = started.body.value.id as string;
    const j = await until(id, (x) => x.status === 'succeeded', 15_000);
    expect(j).toMatchObject({ message: 'Written', progress: 100 });
    const { rows } = await pool.query('select attempts from app.jobs where id = $1', [id]);
    expect(rows[0].attempts).toBe(2);
    // The second attempt's progress was no news: one event for it, one submission audited.
    expect(await events(id)).toEqual([
      'job.queued',
      'job.running',
      'job.progress',
      'job.succeeded',
    ]);
    expect(await audit(id, 'job.submit')).toHaveLength(1);
  });

  it('one a stopped worker left running, never submitted, is taken up again by the tick', async () => {
    const first = (await owner.call('POST', '/api/drawings/export', { title: 'cut' })).body.value;
    await until(first.id, (x) => x.status === 'succeeded');
    // As a worker that stopped mid-submission leaves it: it said it runs, its lease ran out.
    const {
      rows: [cut],
    } = await pool.query(
      `insert into app.jobs (tenant_id, kind, status, progress, message, input, started_for,
         started_by_kind, started_by_id, principal, attempts, lease_until, deadline_at, created_at)
       select tenant_id, kind, 'running', 50, 'Writing', input, started_for, started_by_kind,
         started_by_id, principal, 1, now() - interval '1 second', now() + interval '1 minute',
         now() - interval '1 minute'
       from app.jobs where id = $1 returning id`,
      [first.id],
    );
    await runner().tick();
    const j = await until(cut.id, (x) => x.status === 'succeeded');
    expect(j.submittedAt).toEqual(expect.any(String));
    const { rows } = await pool.query('select attempts from app.jobs where id = $1', [cut.id]);
    expect(rows[0].attempts).toBe(2);
  });

  it('a callback cannot name files: unknown keys are dropped', async () => {
    const id = await running((await drawing('Plan Sneak')).id);
    const stolen = (
      await pool.query(
        "select id from app.files where source = 'server' and resource_id is null limit 1",
      )
    ).rows[0]?.id;
    await post(id, { status: 'succeeded', output: { pages: 0 }, madeFiles: [stolen ?? 'x'] });
    const j = await until(id, (x) => x.status === 'succeeded');
    expect(j.files).toEqual([]);
  });
});

describe('deadlines and cancelling', () => {
  it('a job past its deadline fails as timed out, and its service is told to stop', async () => {
    const id = await running((await drawing('Plan Late')).id);
    const s = await submitted(id);
    await pool.query(
      "update app.jobs set deadline_at = now() - interval '1 second' where id = $1",
      [id],
    );
    expect((await runner().tick()).timedOut).toBeGreaterThanOrEqual(1);
    const j = (await job(owner, id)).body;
    expect(j).toMatchObject({ status: 'failed', error: { code: 'timed_out' } });
    expect(await audit(id, 'job.timeout')).toEqual([
      expect.objectContaining({ actor_kind: 'system' }),
    ]);
    await eventually(() => stand.cancelled.includes(s.id));
  });

  it('the person cancels it, audited; the service is told; again: 409', async () => {
    const id = await running((await drawing('Plan Stop')).id);
    const s = await submitted(id);
    const res = await owner.call('POST', `/api/jobs/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect(await audit(id, 'job.cancel')).toEqual([
      expect.objectContaining({ actor_kind: 'user', actor_id: owner.id }),
    ]);
    expect(await events(id)).toContain('job.cancelled');
    await eventually(() => stand.cancelled.includes(s.id));
    expect((await owner.call('POST', `/api/jobs/${id}/cancel`)).status).toBe(409);
  });
});

describe('live updates', () => {
  type Stream = { messages: LiveMessage[]; raw: string; close: () => void };

  /** This person's live stream (in this business), read in the background. */
  async function stream(who: Person, headers: Record<string, string> = {}) {
    const controller = new AbortController();
    const res = await fetch(`${server.base}/api/live`, {
      headers: { origin, cookie: who.cookie, ...headers },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const s: Stream = { messages: [], raw: '', close: () => controller.abort() };
    const body = res.body as ReadableStream<Uint8Array>;
    async function* tee() {
      for await (const text of textOf(body)) {
        s.raw += text;
        yield text;
      }
    }
    void (async () => {
      try {
        for await (const m of liveMessages(tee())) s.messages.push(m);
      } catch {
        // aborted
      }
    })();
    await eventually(() => s.messages.find((m) => m.kind === 'ready'));
    return s;
  }
  const heard = (s: Stream, id: string) =>
    s.messages.flatMap((m) => (m.kind === 'change' && m.event.id === id ? [m.event] : []));
  const hears = (s: Stream, id: string, name: string) =>
    eventually(() => {
      const found = heard(s, id);
      return found.some((e) => e.name === name) ? found : undefined;
    });

  it('a job’s changes reach whoever reaches it, as ids; nobody else', async () => {
    const ownerS = await stream(owner);
    const staffS = await stream(staff, inTenant());
    const strangerS = await stream(stranger);
    try {
      const rendered = await running((await drawing('Plan Live')).id);
      await post(rendered, { status: 'running', progress: 70, message: 'Live secret step' });
      const seen = await hears(ownerS, rendered, 'job.progress');
      expect(seen.map((e) => e.name)).toEqual(['job.queued', 'job.running', 'job.progress']);
      expect(seen[0]).toEqual({ name: 'job.queued', type: 'job', id: rendered });
      // A colleague who reads the drawing hears of its render.
      await hears(staffS, rendered, 'job.progress');

      // A job about no record: only the person it was started for.
      const converted = (await owner.call('POST', '/api/drawings/convert', { text: 'live' })).body
        .value.id as string;
      await hears(ownerS, converted, 'job.running');

      await new Promise((r) => setTimeout(r, 2500));
      expect(heard(staffS, converted)).toEqual([]);
      expect(heard(strangerS, rendered)).toEqual([]);
      expect(heard(strangerS, converted)).toEqual([]);
      // Ids only: never the message, the input or the output.
      expect(ownerS.raw).not.toContain('Live secret step');
    } finally {
      for (const s of [ownerS, staffS, strangerS]) s.close();
    }
  });
});

describe('personal data', () => {
  it('"delete my data" erases the jobs about no record, and their files; export lists jobs', async () => {
    const started = await owner.call('POST', '/api/drawings/convert', { text: 'forget me' });
    const id = started.body.value.id;
    const s = await submitted(id);
    stand.status.set(s.id, {
      status: 'succeeded',
      files: [{ name: 'me.png', mime: 'image/png', data: png().toString('base64') }],
    });
    const done = await eventually(async () => {
      await runner().tick();
      const x = (await job(owner, id)).body;
      return x.status === 'succeeded' ? x : undefined;
    });
    const aboutDrawing = await running((await drawing('Plan Keep')).id);

    const { DB } = await import('../../dist/infra/db.module.js');
    const db = server.app?.get(DB, { strict: false });
    const subject = { kind: 'user' as const, userId: owner.id };
    const exported = await api.exportPersonalData({ subject, tenantId, db });
    expect((exported.jobs as Json[]).map((j) => j.id)).toEqual(
      expect.arrayContaining([id, aboutDrawing]),
    );

    const counts = await db.transaction((tx: Json) =>
      api.eraseWithContributors({ subject, tenantId, tx }),
    );
    expect(counts.jobs).toBeGreaterThanOrEqual(1);
    const erased = (await job(owner, id)).body;
    expect(erased.input).toEqual({});
    const file = await pool.query('select status, name from app.files where id = $1', [
      done.files[0],
    ]);
    expect(file.rows[0]).toEqual({ status: 'erased', name: 'erased' });
    expect((await job(owner, aboutDrawing)).body.input).toMatchObject({ quality: 'draft' });
  });
});
