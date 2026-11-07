// Exporting a business's data (A11X), against the fixture's tasks and visits
// (fixture/src/features/export): the owner starts an export (a command, audited), the worker
// reads every entity as them (their access, a field hidden from them) and every export source,
// and keeps one zip archive on the job. Others may not start one; another business reaches
// neither the job nor the archive; a business role can grant exporting, and taking it away takes
// the archive away; one export at a time per business; an archive over the file limit fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesService, readZip } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { exportApp, exportGate } from '../fixture/dist/features/export/index.js';

const owner = new Person('Owner Export');
const admin = new Person('Admin Export');
const staff = new Person('Staff Export');
const stranger = new Person('Stranger Export');
let tenantId = '';
let strangerTenant = '';
const here = () => ({ 'x-tenant-id': tenantId });

const BOM = '﻿';

/** Start an export as this person, in our business unless told otherwise. */
const start = (p: Person, body: Json = {}, headers: Record<string, string> = here()) =>
  p.call('POST', '/api/exports', body, headers);

/** Wait until the job has finished, as this person sees it. */
const finished = (p: Person, id: string, headers: Record<string, string> = here()) =>
  eventually(async () => {
    const res = await p.call('GET', `/api/jobs/${id}`, undefined, headers);
    return ['succeeded', 'failed', 'cancelled'].includes(res.body?.status) ? res.body : undefined;
  }, 20_000);

/** Start an export, wait for it, and read its archive. */
async function exported(p: Person, body: Json = {}, headers: Record<string, string> = here()) {
  const started = await start(p, body, headers);
  expect(started.status).toBe(200);
  const job = await finished(p, started.body.value.id, headers);
  expect(job.status).toBe('succeeded');
  return { job, zip: await archive(p, job.files[0], headers) };
}

/** The archive's files, downloaded as this person. */
async function archive(p: Person, fileId: string, headers: Record<string, string> = here()) {
  const got = await p.call('GET', `/api/files/${fileId}`, undefined, headers);
  expect(got.status).toBe(200);
  expect(got.body).toMatchObject({
    mime: 'application/zip',
    name: expect.stringMatching(/^export-\d{4}-\d{2}-\d{2}\.zip$/),
  });
  const res = await fetch(`${server.base}${got.body.url}`);
  expect(res.status).toBe(200);
  return readZip(Buffer.from(await res.arrayBuffer()));
}

const json = (zip: Map<string, Buffer>, name: string) =>
  JSON.parse(zip.get(name)?.toString('utf8') ?? 'null') as Json;
const lines = (zip: Map<string, Buffer>, name: string) =>
  (zip.get(name)?.toString('utf8') ?? '').split('\r\n').filter(Boolean);

const audit = async (action: string, where: string, value: string) =>
  (
    await pool.query(
      `select action, outcome, actor_kind, actor_id, resource_type, resource_id, rule
       from audit.events where action = $1 and ${where} = $2 order by at`,
      [action, value],
    )
  ).rows;

const task = (p: Person, title: string, dueOn?: string, headers = here()) =>
  p.call('POST', '/api/tasks', { title, ...(dueOn ? { dueOn } : {}) }, headers);

beforeAll(async () => {
  await boot(exportApp);
  for (const p of [owner, admin, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  strangerTenant = (await me(stranger)).tenantId;
  await addMember(admin, tenantId, ['admin']);
  await addMember(staff, tenantId, ['staff']);
  expect((await task(owner, 'Owner task A', '2026-12-01')).status).toBe(201);
  expect((await task(owner, 'Owner task B')).status).toBe(201);
  expect((await task(staff, 'Staff task', '2026-12-02')).status).toBe(201);
  expect(
    (await task(stranger, 'Stranger task', undefined, { 'x-tenant-id': strangerTenant })).status,
  ).toBe(201);
});

afterAll(shutdown);

describe('the owner exports the business', () => {
  let job: Json;
  let zip: Map<string, Buffer>;

  it('starts it through the write path: audited, a job queued', async () => {
    const started = await start(owner);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      status: 'done',
      value: {
        kind: 'export.data',
        status: 'queued',
        about: null,
        input: { formats: ['json', 'csv'] },
      },
    });
    const id = started.body.value.id as string;
    expect(await audit('export.start', 'resource_id', tenantId)).toEqual([
      expect.objectContaining({
        outcome: 'committed',
        actor_kind: 'user',
        actor_id: owner.id,
        resource_type: 'tenant',
      }),
    ]);
    expect(await audit('job.start', 'resource_id', id)).toHaveLength(1);
    job = await finished(owner, id);
    expect(job).toMatchObject({ status: 'succeeded', message: 'Ready', error: null });
    expect(job.files).toHaveLength(1);
    expect(await audit('job.succeeded', 'resource_id', id)).toEqual([
      expect.objectContaining({ actor_kind: 'system', actor_id: 'export.data' }),
    ]);
    zip = await archive(owner, job.files[0]);
  });

  it('holds what the owner reads: their own tasks, without the field hidden from them', async () => {
    const tasks = json(zip, 'tasks.json');
    expect(tasks.map((t: Json) => t.title)).toEqual(['Owner task A', 'Owner task B']);
    for (const t of tasks) {
      expect(t).not.toHaveProperty('dueOn');
      expect(t).toMatchObject({ id: expect.any(String), done: false, createdBy: 'person' });
    }
    const csv = zip.get('tasks.csv')?.toString('utf8') ?? '';
    expect(csv.startsWith(BOM)).toBe(true);
    const [header, ...rows] = lines(zip, 'tasks.csv');
    expect(header).toBe(`${BOM}id,title,done,createdBy,createdAt`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(',Owner task A,false,person,');
    // Nobody else's tasks, in this business or another.
    const all = [...zip.values()].map((b) => b.toString('utf8')).join('\n');
    expect(all).not.toContain('Staff task');
    expect(all).not.toContain('Stranger task');
    expect(all).not.toContain('2026-12-01');
  });

  it('skips a module switched off for the business, and says so', async () => {
    expect(zip.has('visits.json')).toBe(false);
    const manifest = json(zip, 'manifest.json');
    expect(manifest).toMatchObject({
      version: 1,
      tenantId,
      exportedBy: { kind: 'user', id: owner.id },
      formats: ['json', 'csv'],
    });
    expect(manifest.skipped).toContainEqual({ name: 'visit', reason: 'switched_off' });
    expect(manifest.parts).toContainEqual({
      name: 'task',
      kind: 'entity',
      module: 'tasks',
      label: 'task',
      rows: 2,
      files: ['tasks.json', 'tasks.csv'],
    });
    expect(job.output).toMatchObject({ formats: ['json', 'csv'], bytes: expect.any(Number) });
    expect(job.output.parts).toContainEqual({
      name: 'task',
      kind: 'entity',
      module: 'tasks',
      label: 'task',
      rows: 2,
    });
  });

  it('adds the export sources, read as the owner and projected for them', async () => {
    expect(json(zip, 'fixture-notes.json')).toEqual([
      {
        tenantId,
        readAs: owner.id,
        note: '=SUM(1,2)',
        at: '2026-01-02T03:04:05.000Z',
      },
    ]);
    const [header, row] = lines(zip, 'fixture-notes.csv');
    expect(header).toBe(`${BOM}tenantId,readAs,note,at`);
    // A spreadsheet would run it: the CSV keeps it as text.
    expect(row).toBe(`${tenantId},${owner.id},"'=SUM(1,2)",2026-01-02T03:04:05.000Z`);
  });

  it('lists the export among the owner’s jobs', async () => {
    const res = await owner.call('GET', '/api/jobs?kind=export.data', undefined, here());
    expect(res.body.items.map((j: Json) => j.id)).toContain(job.id);
  });

  it('another business reaches neither the job nor the archive, and exports only its own', async () => {
    expect((await stranger.call('GET', `/api/jobs/${job.id}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/files/${job.files[0]}`)).status).toBe(404);
    expect((await stranger.call('GET', '/api/jobs?kind=export.data')).body.items).toEqual([]);
    const theirs = await exported(stranger, {}, { 'x-tenant-id': strangerTenant });
    expect(json(theirs.zip, 'tasks.json').map((t: Json) => t.title)).toEqual(['Stranger task']);
    expect(json(theirs.zip, 'manifest.json').tenantId).toBe(strangerTenant);
  });
});

describe('who may export', () => {
  it('an admin reads every task and its due date, but may not export (audited)', async () => {
    const tasks = await admin.call('GET', '/api/tasks', undefined, here());
    expect(tasks.body.items).toHaveLength(3);
    expect(tasks.body.items[0]).toHaveProperty('dueOn');
    const res = await start(admin);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', rule: 'needs_data_export' });
    expect(await audit('export.start', 'actor_id', admin.id)).toEqual([
      expect.objectContaining({ outcome: 'denied', rule: 'needs_data_export' }),
    ]);
  });

  it('staff may not either', async () => {
    const res = await start(staff);
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('needs_data_export');
  });

  it('the assistant cannot start an export, even for the owner', async () => {
    const agent = asAssistant(`user:${owner.id}`, here());
    const res = await agent('POST', '/api/exports', {});
    expect(res.status).toBe(403);
    expect((await audit('export.start', 'actor_id', 'assistant')).length).toBe(0);
  });

  it('a business role can grant it: its holder exports what they read', async () => {
    const role = await owner.call('POST', '/api/members/roles', {
      name: 'exporter',
      label: { en: 'Exporter' },
      capabilities: ['data.export'],
    });
    expect(role.status).toBe(200);
    expect(
      (await owner.call('PATCH', `/api/members/${staff.id}`, { roles: ['staff', 'exporter'] }))
        .status,
    ).toBe(200);
    const { job, zip } = await exported(staff);
    // Staff read their own tasks only; the due date stays hidden from them.
    expect(json(zip, 'tasks.json')).toEqual([expect.objectContaining({ title: 'Staff task' })]);
    expect(json(zip, 'tasks.json')[0]).not.toHaveProperty('dueOn');
    expect(json(zip, 'fixture-notes.json')[0].readAs).toBe(staff.id);

    // Taking the role away takes the archive away: no files on the job, the file is 404.
    expect(
      (await owner.call('PATCH', `/api/members/${staff.id}`, { roles: ['staff'] })).status,
    ).toBe(200);
    const seen = await staff.call('GET', `/api/jobs/${job.id}`, undefined, here());
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ status: 'succeeded', files: [], output: null });
    expect((await staff.call('GET', `/api/files/${job.files[0]}`, undefined, here())).status).toBe(
      404,
    );
    expect((await start(staff)).status).toBe(403);
  });
});

describe('what an export holds', () => {
  it('only and formats narrow it; an unknown part is 400', async () => {
    const { zip } = await exported(owner, { only: ['task'], formats: ['csv'] });
    expect([...zip.keys()]).toEqual(['tasks.csv', 'manifest.json']);
    expect(json(zip, 'manifest.json')).toMatchObject({ formats: ['csv'], skipped: [] });
    const bad = await start(owner, { only: ['task', 'nothing'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown_export_part');
    expect((await start(owner, { formats: ['xml'] })).status).toBe(400);
  });

  it('a module switched on for the business is exported', async () => {
    await setTenantSettings(tenantId, { features: { 'fixture.visits': true } });
    try {
      const visit = await owner.call(
        'POST',
        '/api/visits',
        { title: 'Owner visit', startsAt: '2026-12-01T10:00:00Z', endsAt: '2026-12-01T11:00:00Z' },
        here(),
      );
      expect(visit.status).toBe(201);
      const { zip } = await exported(owner, { only: ['visit', 'task'] });
      expect(json(zip, 'visits.json').map((v: Json) => v.title)).toEqual(['Owner visit']);
      expect(json(zip, 'manifest.json').skipped).toEqual([]);
    } finally {
      await setTenantSettings(tenantId, { features: null });
    }
  });
});

describe('limits', () => {
  it('one export of a business at a time; another business is not held up', async () => {
    let release = () => {};
    exportGate.hold = new Promise<void>((r) => {
      release = r;
    });
    try {
      const first = await start(owner);
      expect(first.status).toBe(200);
      const again = await start(owner);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('export_running');
      release();
      exportGate.hold = undefined;
      expect((await finished(owner, first.body.value.id)).status).toBe('succeeded');
      // Once it finished, the next one may start.
      const next = await exported(owner, { only: ['task'] });
      expect(next.job.status).toBe('succeeded');
    } finally {
      release();
      exportGate.hold = undefined;
    }
  });

  it('an archive larger than one file may be fails as too large', async () => {
    const files = server.app?.get(FilesService, { strict: false });
    if (!files) throw new Error('The app is not booted');
    const config = files.config as { maxBytes: number };
    const before = config.maxBytes;
    config.maxBytes = 200;
    try {
      const started = await start(owner);
      const job = await finished(owner, started.body.value.id);
      expect(job).toMatchObject({
        status: 'failed',
        error: { code: 'too_large', message: expect.stringContaining('200 bytes') },
        files: [],
      });
    } finally {
      config.maxBytes = before;
    }
  });
});
