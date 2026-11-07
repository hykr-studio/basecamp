// The to-dos module's import demo (B20): the old system's CSV export of to-dos
// (application/domain/src/modules/todos/import/todos.csv, keyed by its `legacy_id`), imported
// through the typed client the app uses (upload, then POST /api/imports), run by the worker as
// a job: every row a to-do's own create (and update, for `done`), as the owner. Importing it
// again adds nothing; a fixed error report imports the rest; the business's own fields come in
// as JSON; staff may not import, and another business never sees the job or its report.
import { readFile } from 'node:fs/promises';
import {
  addMember,
  boot,
  eventually,
  me,
  origin,
  Person,
  server,
  shutdown,
} from '@hykr/api/testing';
import { createApiClient } from '@hykr/api-client';
import { type ImportResult, isJobFinished, type JobInfo } from '@hykr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const CSV = new URL('../../../domain/src/modules/todos/import/todos.csv', import.meta.url);

const owner = new Person('Owner Import');
const staff = new Person('Staff Import');
const stranger = new Person('Stranger Import');
let tenantId = '';

const clientOf = (who: Person, tenant?: string) =>
  createApiClient({
    baseUrl: server.base,
    headers: () => ({
      origin,
      cookie: who.cookie,
      ...(tenant ? { 'x-tenant-id': tenant } : {}),
    }),
  });

/** Upload the text as a CSV file and start an import of to-dos from it; the finished job. */
async function importCsv(
  who: Person,
  text: string,
  options: { dryRun?: boolean; source?: string } = {},
): Promise<JobInfo> {
  const api = clientOf(who);
  const file = await api.imports.upload(new TextEncoder().encode(text), {
    name: 'todos.csv',
    mime: 'text/csv',
  });
  const started = await api.imports.start({
    entity: 'todo',
    file: file.id,
    key: 'legacy_id',
    source: options.source ?? 'legacy',
    dryRun: options.dryRun ?? false,
  });
  if (started.status !== 'done') throw new Error(`the import did not start: ${started.status}`);
  return eventually(async () => {
    const job = await api.jobs.get(started.value.id);
    return isJobFinished(job.status) ? job : undefined;
  }, 20_000);
}

const result = (job: JobInfo) => job.output as ImportResult;

const todos = async (who: Person) =>
  (await who.call('GET', '/api/todos?limit=100')).body.items as {
    id: string;
    title: string;
    done: boolean;
    dueOn: string | null;
    cost?: number | null;
    custom: Record<string, unknown>;
  }[];

let csv = '';

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  csv = await readFile(CSV, 'utf8');
});
afterAll(shutdown);

describe('importing the old system’s to-dos', () => {
  let dry: JobInfo;
  let first: JobInfo;

  beforeAll(async () => {
    dry = await importCsv(owner, csv, { dryRun: true });
    first = await importCsv(owner, csv);
  });

  it('a dry run first says what it would do, and writes nothing', async () => {
    expect(dry.status).toBe('succeeded');
    expect(result(dry)).toMatchObject({ dryRun: true, rows: 5, created: 5, failed: 0 });
    // The real run after it still created all five: the dry run left no keys and no to-dos.
    expect(result(first)).toMatchObject({ dryRun: false, created: 5 });
    expect(await todos(owner)).toHaveLength(5);
  });

  it('writes every row as the owner’s to-do, done ones done, with their cost', async () => {
    expect(first.status).toBe('succeeded');
    expect(result(first)).toMatchObject({ rows: 5, created: 5, updated: 0, failed: 0 });
    expect(first.files).toEqual([]);
    const mine = await todos(owner);
    const tiles = mine.find((t) => t.title === 'Order the floor tiles');
    expect(tiles).toMatchObject({ dueOn: '2026-11-20', done: false, cost: 450000 });
    expect(mine.find((t) => t.title === 'Measure the kitchen')).toMatchObject({ done: true });
    expect(mine.some((t) => t.title === 'Confirm the paint colours, both rooms')).toBe(true);
  });

  it('again: nothing new; a changed row updates its to-do', async () => {
    const again = await importCsv(owner, csv);
    expect(result(again)).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    const moved = csv.replace(
      'T-1002,Book the electrician,2026-11-12',
      'T-1002,Book the electrician,2026-11-14',
    );
    expect(result(await importCsv(owner, moved))).toMatchObject({ updated: 1, unchanged: 4 });
    const booked = (await todos(owner)).filter((t) => t.title === 'Book the electrician');
    expect(booked.map((t) => t.dueOn)).toEqual(['2026-11-14']);
  });

  it('rows it cannot write come back in a report that imports once fixed', async () => {
    const bad = [
      'legacy_id,title,dueOn',
      'T-2001,Fix the gate,soon',
      'T-2002,,2026-12-01',
      'T-2003,Paint the fence,2026-12-02',
    ].join('\n');
    const job = await importCsv(owner, bad);
    expect(result(job)).toMatchObject({ created: 1, failed: 2, errors: { invalid: 2 } });
    const report = await clientOf(owner).files.get(job.files[0]);
    expect(report.name).toBe('todos.errors.csv');
    const text = await (await fetch(report.url as string)).text();
    expect(text.split('\r\n')[0]).toBe('_row,_code,_field,_message,legacy_id,title,dueOn');
    const fixed = text
      .replace('Fix the gate,soon', 'Fix the gate,2026-12-03')
      .replace('T-2002,,', 'T-2002,Oil the hinges,');
    expect(result(await importCsv(owner, fixed))).toMatchObject({ created: 2, failed: 0 });
  });

  it('the business’s own fields come in as JSON', async () => {
    const field = await owner.call('POST', '/api/custom-fields', {
      entity: 'todo',
      key: 'priority',
      type: 'select',
      label: { en: 'Priority', hi: 'प्राथमिकता', te: 'ప్రాధాన్యత' },
      options: ['low', 'high'],
    });
    expect(field.status).toBe(201);
    const job = await importCsv(
      owner,
      [
        'legacy_id,title,custom',
        'T-3001,Sweep the yard,"{""priority"":""high""}"',
        'T-3002,Wash the car,"{""priority"":""now""}"',
      ].join('\n'),
    );
    expect(result(job)).toMatchObject({ created: 1, failed: 1, errors: { invalid: 1 } });
    expect((await todos(owner)).find((t) => t.title === 'Sweep the yard')?.custom).toEqual({
      priority: 'high',
    });
  });
});

describe('who imports', () => {
  it('not staff: neither the upload nor the start', async () => {
    const api = clientOf(staff, tenantId);
    await expect(
      api.imports.upload(new TextEncoder().encode(csv), { name: 'todos.csv', mime: 'text/csv' }),
    ).rejects.toMatchObject({ status: 403 });
    const file = await clientOf(owner).imports.upload(new TextEncoder().encode(csv), {
      name: 'todos.csv',
      mime: 'text/csv',
    });
    await expect(api.imports.start({ entity: 'todo', file: file.id })).rejects.toMatchObject({
      status: 403,
      body: { rule: 'needs_imports_run' },
    });
  });

  it('another business never reaches the job, its report or our to-dos', async () => {
    const job = await importCsv(owner, 'legacy_id,title\nT-4001,Ours,\nT-4002,\n');
    expect(job.files).toHaveLength(1);
    expect((await stranger.call('GET', `/api/jobs/${job.id}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/files/${job.files[0]}`)).status).toBe(404);
    // Their own import of the same keys makes their own to-dos.
    expect(result(await importCsv(stranger, csv))).toMatchObject({ created: 5 });
    expect((await todos(stranger)).some((t) => t.title === 'Ours')).toBe(false);
  });
});
