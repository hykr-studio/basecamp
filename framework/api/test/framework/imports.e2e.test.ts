// Bulk import (B20), against the fixture's `shelves` module (fixture/src/features/imports): a
// file uploaded for an import, started with POST /api/imports (or importFile, the CLI's path),
// run by the worker as a job, each row through runWrite as the starter; keys remembered so a
// re-run makes nothing twice; rows not written in an error report that imports again once fixed;
// dry runs; another business gets 404; hidden fields stay hidden; a parked start is audited.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  shutdown,
} from '../../dist/testing.js';
import { importsApp } from '../fixture/dist/features/imports/index.js';

type Api = typeof import('../../dist/index.js');
let api: Api;

const owner = new Person('Owner Imports');
const admin = new Person('Admin Imports');
const staff = new Person('Staff Imports');
const importer = new Person('Importer Imports');
const stranger = new Person('Stranger Imports');
let tenantId = '';
const as = (p: Person) => (p === owner || p === stranger ? {} : { 'x-tenant-id': tenantId });

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** Upload a file for an import, in three steps; the presign's answer when it is refused. */
async function upload(person: Person, text: string, name = 'rows.csv', mime = 'text/csv') {
  const bytes = Buffer.from(text);
  const pre = await person.call(
    'POST',
    '/api/files',
    { name, mime, size: bytes.length, for: { entity: 'import', field: 'file' } },
    as(person),
  );
  if (pre.status !== 201) return { id: '', pre };
  const put = await fetch(`${server.base}${pre.body.upload.url}`, {
    method: 'PUT',
    headers: pre.body.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(`${put.status} ${put.status === 200 ? '' : await put.text()}`).toBe('200 ');
  const confirmed = await person.call(
    'POST',
    `/api/files/${pre.body.file.id}/confirm`,
    undefined,
    as(person),
  );
  expect(confirmed.status).toBe(200);
  return { id: pre.body.file.id as string, pre };
}

const start = (person: Person, body: Json) => person.call('POST', '/api/imports', body, as(person));

const job = (person: Person, id: string) =>
  person.call('GET', `/api/jobs/${id}`, undefined, as(person));

/** Wait until the job has finished, as whoever started it. */
const finished = (person: Person, id: string) =>
  eventually(async () => {
    const j = (await job(person, id)).body;
    return ['succeeded', 'failed', 'cancelled'].includes(j?.status) ? j : undefined;
  }, 20_000);

/** Upload, start and wait: the finished job. */
async function importText(
  person: Person,
  entity: string,
  text: string,
  options: Json = {},
  file: { name?: string; mime?: string } = {},
) {
  const { id } = await upload(person, text, file.name, file.mime);
  const started = await start(person, { entity, file: id, ...options });
  expect(started.body.status).toBe('done');
  return finished(person, started.body.value.id);
}

/** The text of a job's error report, as its starter downloads it. */
async function reportOf(person: Person, j: Json): Promise<string> {
  expect(j.files).toHaveLength(1);
  const file = await person.call('GET', `/api/files/${j.files[0]}`, undefined, as(person));
  expect(file.status).toBe(200);
  return (await fetch(new URL(file.body.url, server.base))).text();
}

const items = async (person: Person) =>
  (await person.call('GET', '/api/items?limit=200', undefined, as(person))).body.items as Json[];

const itemByTitle = async (title: string, person: Person = owner) =>
  (await items(person)).find((i) => i.title === title);

const audit = async (where: string, params: unknown[]) =>
  (
    await pool.query(
      `select action, outcome, actor_kind, actor_id, run_id, resource_id, after from audit.events where ${where} order by at`,
      params,
    )
  ).rows;

const keys = async (source: string, tenant = tenantId) =>
  (
    await pool.query(
      'select entity, external_id, record_id from app.import_keys where tenant_id = $1 and source = $2 order by external_id',
      [tenant, source],
    )
  ).rows;

let shelfA = '';

beforeAll(async () => {
  // Two rows per batch: every import here runs in several batches.
  process.env.IMPORTS_BATCH_SIZE = '2';
  api = await import('../../dist/index.js');
  await boot(importsApp);
  for (const p of [owner, admin, staff, importer, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(admin, tenantId, ['admin']);
  await addMember(staff, tenantId, ['staff']);
  await addMember(importer, tenantId, ['fixture_importer']);
  const shelves = await importText(owner, 'shelf', 'id,title\nS1,Top\nS2,Middle\nS3,Bottom\n', {
    source: 'legacy',
  });
  expect(shelves.output).toMatchObject({ created: 3, failed: 0 });
  shelfA = (await keys('legacy')).find((k) => k.external_id === 'S1')?.record_id;
});

afterAll(async () => {
  await shutdown();
});

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('uploading a file to import', () => {
  it('takes CSV and JSON from someone who may import, and nothing else', async () => {
    expect((await upload(owner, 'id,title\n')).pre.status).toBe(201);
    expect((await upload(owner, '[]', 'rows.json', 'application/json')).pre.status).toBe(201);
    expect((await upload(owner, 'x', 'a.png', 'image/png')).pre.status).toBe(415);
    const refused = await upload(staff, 'id,title\n');
    expect(refused.pre.status).toBe(403);
    expect(refused.pre.body.rule).toBe('needs_imports_run');
    const withId = await owner.call('POST', '/api/files', {
      name: 'a.csv',
      mime: 'text/csv',
      size: 3,
      for: { entity: 'import', field: 'file', id: crypto.randomUUID() },
    });
    expect(withId.status).toBe(400);
  });
});

describe('an import through the write path', () => {
  let done: Json;
  const file = [
    'id,title,shelfId,qty,tags,done,cost',
    'I1,Bolts,S1,4,"[""steel""]",,120',
    'I2,Nuts,S2,10,,true,',
    'I3,Washers,,0,,,',
  ].join('\n');

  beforeAll(async () => {
    done = await importText(owner, 'item', file, { source: 'legacy', refs: { shelfId: 'shelf' } });
  });

  it('runs as a job of its starter and writes every row', async () => {
    expect(done).toMatchObject({ kind: 'imports.records', status: 'succeeded', files: [] });
    expect(done.output).toEqual({
      entity: 'item',
      source: 'legacy',
      dryRun: false,
      rows: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      errors: {},
      reportRows: 0,
      reportTruncated: false,
    });
    const bolts = await itemByTitle('Bolts');
    expect(bolts).toMatchObject({ qty: 4, tags: ['steel'], cost: 120, done: false });
    expect(bolts.shelfId).toBe(shelfA);
    // `done` is only in the update schema: written after the create.
    expect(await itemByTitle('Nuts')).toMatchObject({
      qty: 10,
      done: true,
      shelfId: expect.any(String),
    });
    expect(await itemByTitle('Washers')).toMatchObject({ shelfId: null, qty: 0 });
  });

  it('audits each record as the starter, with the job as its run, and the import itself', async () => {
    const nuts = await itemByTitle('Nuts');
    const rows = await audit('resource_id = $1', [nuts.id]);
    expect(rows.map((r) => r.action)).toEqual(['item.create', 'item.update']);
    for (const r of rows)
      expect(r).toMatchObject({ actor_kind: 'user', actor_id: owner.id, run_id: done.id });
    const [summary] = await audit("action = 'import.done' and resource_id = $1", [done.id]);
    expect(summary).toMatchObject({ actor_id: owner.id, outcome: 'committed' });
    expect(summary.after).toMatchObject({ created: 3, entity: 'item' });
    const started = await audit("action = 'import.start' and actor_id = $1", [owner.id]);
    expect(started.length).toBeGreaterThan(0);
  });

  it('remembers each key, so a re-run makes nothing twice', async () => {
    expect((await keys('legacy')).filter((k) => k.entity === 'item')).toHaveLength(3);
    const again = await importText(owner, 'item', file, {
      source: 'legacy',
      refs: { shelfId: 'shelf' },
    });
    expect(again.output).toMatchObject({ created: 0, updated: 0, unchanged: 3, failed: 0 });
    expect((await items(owner)).filter((i) => i.title === 'Bolts')).toHaveLength(1);
  });

  it('a changed row updates its record; skip leaves it', async () => {
    const changed = file.replace('I3,Washers,,0', 'I3,Washers,,7');
    const updated = await importText(owner, 'item', changed, {
      source: 'legacy',
      refs: { shelfId: 'shelf' },
    });
    expect(updated.output).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect((await itemByTitle('Washers')).qty).toBe(7);
    const skipped = await importText(owner, 'item', file, {
      source: 'legacy',
      refs: { shelfId: 'shelf' },
      existing: 'skip',
    });
    expect(skipped.output).toMatchObject({ created: 0, skipped: 3 });
    expect((await itemByTitle('Washers')).qty).toBe(7);
  });

  it('another source is another system: its keys are its own', async () => {
    const other = await importText(owner, 'item', 'id,title\nI1,Bolts from elsewhere\n', {
      source: 'elsewhere',
    });
    expect(other.output).toMatchObject({ created: 1 });
  });
});

describe('rows that are not written', () => {
  let done: Json;
  const file = [
    'id,title,qty,shelfId',
    'B1,Good,1,S1',
    'B2,Too many,many,',
    ',No key,1,',
    'B1,Twice,1,',
    'B4,Refused title,1,',
    'B5,Lost,1,S9',
    'B6,Wait for it,1,',
  ].join('\n');

  beforeAll(async () => {
    // References are keys in the same source: this source's shelves, not S9.
    await importText(owner, 'shelf', 'id,title\nS1,Bad top\nS3,Bad bottom\n', { source: 'bad' });
    done = await importText(owner, 'item', file, { source: 'bad', refs: { shelfId: 'shelf' } });
  });

  it('are counted by why', () => {
    expect(done.status).toBe('succeeded');
    expect(done.output).toMatchObject({
      rows: 7,
      created: 1,
      failed: 6,
      errors: {
        invalid: 1,
        missing_key: 1,
        duplicate_key: 1,
        forbidden: 1,
        unknown_reference: 1,
        needs_approval: 1,
      },
    });
  });

  it('are listed in the report with the row as given', async () => {
    const text = await reportOf(owner, done);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('_row,_code,_field,_message,id,title,qty,shelfId');
    expect(lines.slice(1).map((l) => l.split(',').slice(0, 3).join(','))).toEqual([
      '2,invalid,qty',
      '3,missing_key,id',
      '4,duplicate_key,id',
      '5,forbidden,',
      '6,unknown_reference,shelfId',
      '7,needs_approval,',
    ]);
    expect(lines[1]).toMatch(/,B2,Too many,many,$/);
    expect(lines[4]).toMatch(
      /Titles starting with Refused are refused \(fixture\.items\.refused\)/,
    );
  });

  it('a refusal is audited, a row that would wait is never parked', async () => {
    const denied = await audit("action = 'item.create' and outcome = 'denied' and run_id = $1", [
      done.id,
    ]);
    expect(denied).toHaveLength(1);
    const { rows } = await pool.query(
      `select count(*)::int as n from app.approvals where tenant_id = $1 and action = 'item.create'`,
      [tenantId],
    );
    expect(rows[0].n).toBe(0);
    expect(await itemByTitle('Wait for it')).toBeUndefined();
  });

  it('the report, fixed, imports the rest', async () => {
    const fixed = (await reportOf(owner, done))
      .replace('B2,Too many,many,', 'B2,Too many,2,')
      .replace(',,No key,1,', ',B3,No key,1,')
      .replace(',B1,Twice,1,', ',B7,Twice,1,')
      .replace('B4,Refused title', 'B4,Accepted title')
      .replace('B5,Lost,1,S9', 'B5,Lost,1,S3')
      .replace('B6,Wait for it', 'B6,Held for it');
    const again = await importText(owner, 'item', fixed, {
      source: 'bad',
      refs: { shelfId: 'shelf' },
    });
    expect(again.output).toMatchObject({ rows: 6, created: 6, failed: 0 });
    expect(again.files).toEqual([]);
    expect(await itemByTitle('Too many')).toMatchObject({ qty: 2 });
  });
});

describe('a file that cannot be imported fails before anything is written', () => {
  it('unknown columns', async () => {
    const j = await importText(owner, 'item', 'id,title,colour\nU1,Red thing,red\n');
    expect(j.status).toBe('failed');
    expect(j.error).toEqual({
      code: 'unknown_columns',
      message: 'These columns are not fields of a item: colour',
    });
    expect(await itemByTitle('Red thing')).toBeUndefined();
  });

  it('no key column, or a file that does not parse', async () => {
    expect((await importText(owner, 'item', 'title\nKeyless\n')).error.code).toBe(
      'missing_key_column',
    );
    expect((await importText(owner, 'item', 'id,title\n1,"open\n')).error.code).toBe('unreadable');
  });

  it('an entity that is not here, opted out, or a column mapped to no field', async () => {
    const { id } = await upload(owner, 'id,title\n');
    expect((await start(owner, { entity: 'nothing', file: id })).status).toBe(404);
    const bins = await start(owner, { entity: 'bin', file: id });
    expect(bins.status).toBe(400);
    expect(bins.body).toMatchObject({
      error: 'not_importable',
      message: 'bin records are not imported from files',
    });
    const bad = await start(owner, { entity: 'item', file: id, columns: { Name: 'colour' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown_field');
    expect(
      (await start(owner, { entity: 'item', file: id, refs: { shelfId: 'nothing' } })).status,
    ).toBe(404);
  });
});

describe('a dry run', () => {
  it('reports what a real run would do, and writes nothing', async () => {
    const file = 'id,title,qty\nD1,Dry one,1\nD2,Dry two,x\nD3,Dry three,3\n';
    const dry = await importText(owner, 'item', file, { source: 'dry', dryRun: true });
    expect(dry.output).toMatchObject({ dryRun: true, rows: 3, created: 2, failed: 1 });
    expect(dry.message).toMatch(/nothing was written/);
    expect(await itemByTitle('Dry one')).toBeUndefined();
    expect(await keys('dry')).toEqual([]);
    expect(await reportOf(owner, dry)).toMatch(/2,invalid,qty/);
    const real = await importText(owner, 'item', file, { source: 'dry' });
    expect(real.output).toMatchObject({ dryRun: false, created: 2, failed: 1 });
    expect(await keys('dry')).toHaveLength(2);
  });
});

describe('JSON and NDJSON', () => {
  it('an array of objects, typed as they are', async () => {
    const j = await importText(
      owner,
      'item',
      JSON.stringify([
        { id: 'J1', title: 'From JSON', qty: 5, tags: ['a', 'b'] },
        { id: 'J2', title: 'Bad JSON', qty: '5' },
      ]),
      { source: 'json' },
      { name: 'items.json', mime: 'application/json' },
    );
    expect(j.output).toMatchObject({ created: 1, failed: 1, errors: { invalid: 1 } });
    expect(await itemByTitle('From JSON')).toMatchObject({ qty: 5, tags: ['a', 'b'] });
    const report = await reportOf(owner, j);
    expect(JSON.parse(report.trim())).toMatchObject({ _row: 2, _code: 'invalid', id: 'J2' });
  });

  it('one object per line', async () => {
    const j = await importText(
      owner,
      'item',
      '{"id":"N1","title":"From NDJSON","done":true}\n{"id":"N2","title":"Second line"}\n',
      { source: 'ndjson' },
      { name: 'items.ndjson', mime: 'application/x-ndjson' },
    );
    expect(j.output).toMatchObject({ created: 2, failed: 0 });
    expect(await itemByTitle('From NDJSON')).toMatchObject({ done: true });
  });
});

describe('hidden fields', () => {
  it('someone who may not write a field cannot import it, and never sees it', async () => {
    const j = await importText(admin, 'item', 'id,title,cost\nH1,Priced,99\nH2,Unpriced,\n', {
      source: 'admin',
    });
    expect(j.output).toMatchObject({ created: 1, failed: 1, errors: { forbidden: 1 } });
    expect(await itemByTitle('Priced')).toBeUndefined();
    const unpriced = await itemByTitle('Unpriced', admin);
    expect(unpriced).toBeDefined();
    expect(unpriced).not.toHaveProperty('cost');
    // An owner's priced item, read by the admin: no cost.
    expect(await itemByTitle('Bolts', admin)).not.toHaveProperty('cost');
  });
});

describe('another business', () => {
  let ours: Json;
  beforeAll(async () => {
    ours = await importText(owner, 'item', 'id,title,qty\nX1,Ours,1\nX2,Ours bad,x\n', {
      source: 'cross',
    });
  });

  it('gets 404 for the job and its report', async () => {
    expect((await job(stranger, ours.id)).status).toBe(404);
    expect((await stranger.call('GET', `/api/files/${ours.files[0]}`)).status).toBe(404);
    expect((await job(admin, ours.id)).status).toBe(404);
  });

  it('cannot import our file', async () => {
    const { id } = await upload(owner, 'id,title\nZ1,Stolen\n');
    const res = await start(stranger, { entity: 'item', file: id });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('file_unavailable');
  });

  it('has keys of its own, and never reaches our records through them', async () => {
    const theirs = await importText(
      stranger,
      'item',
      'id,title,shelfId\nX1,Theirs,S1\nX3,Plain,\n',
      {
        source: 'cross',
        refs: { shelfId: 'shelf' },
      },
    );
    // X1 is ours in this source: theirs is a new record; S1 is our shelf: unknown to them.
    expect(theirs.output).toMatchObject({
      created: 1,
      failed: 1,
      errors: { unknown_reference: 1 },
    });
    const again = await importText(stranger, 'item', 'id,title\nX1,Theirs\n', { source: 'cross' });
    expect(again.output).toMatchObject({ created: 1 });
    expect(await itemByTitle('Theirs')).toBeUndefined();
    expect((await items(stranger)).map((i) => i.title).sort()).toEqual(['Plain', 'Theirs']);
  });
});

describe('who may import', () => {
  it('not staff, and not the assistant', async () => {
    const { id } = await upload(owner, 'id,title\nW1,Nope\n');
    const res = await start(staff, { entity: 'item', file: id });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('needs_imports_run');
    const [denied] = await audit(
      "action = 'import.start' and outcome = 'denied' and actor_id = $1",
      [staff.id],
    );
    expect(denied).toBeDefined();
    const agent = await asAssistant(owner.id)('POST', '/api/imports', { entity: 'item', file: id });
    expect(agent.status).toBe(403);
  });

  it("a business's importer waits for approval, audited; once approved, it runs as them", async () => {
    const { id } = await upload(importer, 'id,title\nP1,Parked one\nP2,Wait here\n');
    const res = await start(importer, { entity: 'item', file: id, source: 'parked' });
    expect(res.body.status).toBe('needs_approval');
    const approvalId = res.body.approval.id as string;
    const [parked] = await audit(
      "action = 'import.start' and outcome = 'needs_approval' and actor_id = $1",
      [importer.id],
    );
    expect(parked.after).toMatchObject({ approvalId });
    // The importer cannot decide it; the owner does.
    expect(
      (await importer.call('POST', `/api/approvals/${approvalId}/approve`, undefined, as(importer)))
        .status,
    ).toBe(403);
    const approved = await owner.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const listed = await importer.call(
      'GET',
      '/api/jobs?kind=imports.records',
      undefined,
      as(importer),
    );
    const jobId = listed.body.items[0].id as string;
    const j = await finished(importer, jobId);
    // The approval was for the import: each row is still decided on its own.
    expect(j.output).toMatchObject({ created: 1, failed: 1, errors: { needs_approval: 1 } });
    const mine = await items(importer);
    expect(mine.map((i) => i.title)).toEqual(['Parked one']);
    const [row] = await audit("action = 'item.create' and run_id = $1", [jobId]);
    expect(row).toMatchObject({ actor_id: importer.id, outcome: 'committed' });
  });
});

describe('importFile: the command line’s path', () => {
  it('stores the file as the member, starts the import as them and saves the report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b20-'));
    const path = join(dir, 'shelves.csv');
    await writeFile(path, 'id,title\nC1,From disk\nC2,\n');
    const lines: string[] = [];
    const out = await api.importFile(server.app as never, {
      entity: 'shelf',
      path,
      as: owner.email,
      source: 'disk',
      everyMs: 100,
      log: (l: string) => lines.push(l),
    });
    expect(out.status).toBe('finished');
    expect(out.result).toMatchObject({ created: 1, failed: 1 });
    expect(out.reportPath).toBe(join(dir, 'shelves.errors.csv'));
    expect(await readFile(out.reportPath as string, 'utf8')).toMatch(
      /^_row,_code,_field,_message,id,title/,
    );
    expect(lines[0]).toMatch(/^Import .* started$/);
    expect(api.importSummary(out)[0]).toBe(
      '2 rows: 1 created, 0 updated, 0 unchanged, 0 skipped, 1 not written',
    );
    const [stored] = await audit(
      "action = 'item.create' or (action = 'shelf.create' and run_id = $1)",
      [out.job?.id],
    ).then((rows) => rows.filter((r) => r.action === 'shelf.create'));
    expect(stored).toMatchObject({ actor_id: owner.id });
    await expect(
      api.importFile(server.app as never, { entity: 'shelf', path, as: 'nobody@test.local' }),
    ).rejects.toThrow(/Nobody is signed up/);
    // Staff may not import: the command line says why.
    const refused = await api
      .importFile(server.app as never, { entity: 'shelf', path, as: staff.email, tenant: tenantId })
      .catch((e: unknown) => e);
    expect(api.failureText(refused)).toBe(
      'Only someone who may import records can do this (needs_imports_run)',
    );
    await expect(
      api.importFile(server.app as never, {
        entity: 'shelf',
        path,
        as: stranger.email,
        tenant: tenantId,
      }),
    ).rejects.toThrow(/not a member/);
  });
});
