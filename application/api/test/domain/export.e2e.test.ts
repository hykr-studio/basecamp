// Exporting the business's data (A11X) in the sample: the owner exports (owners may, by the
// framework's default), and the archive holds every module's records the owner reads, with the
// to-dos' cost they see. Ops may not, until the owner gives them a business role that may; their
// export then holds every to-do of the business, without the cost they never see. Another
// business's records are never in it.
import { readZip } from '@hykr/api';
import {
  addMember,
  boot,
  eventually,
  type Json,
  me,
  Person,
  server,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Export');
const ops = new Person('Ops Export');
const other = new Person('Other Export');
let tenantId = '';
const here = () => ({ 'x-tenant-id': tenantId });

/** Start an export as this person, wait for it, and read its archive. */
async function exported(p: Person, body: Json = {}) {
  const started = await p.call('POST', '/api/exports', body, here());
  expect(started.status).toBe(200);
  const job = await eventually(async () => {
    const res = await p.call('GET', `/api/jobs/${started.body.value.id}`, undefined, here());
    return ['succeeded', 'failed'].includes(res.body?.status) ? res.body : undefined;
  }, 30_000);
  expect(job).toMatchObject({ status: 'succeeded', files: [expect.any(String)] });
  const file = await p.call('GET', `/api/files/${job.files[0]}`, undefined, here());
  const res = await fetch(`${server.base}${file.body.url}`);
  return readZip(Buffer.from(await res.arrayBuffer()));
}

const records = (zip: Map<string, Buffer>, name: string) =>
  JSON.parse(zip.get(name)?.toString('utf8') ?? '[]') as Json[];

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, ops, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await owner.call('POST', '/api/todos', { title: 'Order tiles', cost: 25_000 });
  await owner.call('POST', '/api/notes', { title: 'Tile colours', body: 'Grey, matte' });
  await ops.call('POST', '/api/todos', { title: 'Book the van' }, here());
  await other.call('POST', '/api/todos', { title: 'Someone else’s to-do' });
});
afterAll(shutdown);

describe('exporting the business', () => {
  it('the owner exports what they read, every module, with the cost', async () => {
    const zip = await exported(owner);
    const manifest = JSON.parse(zip.get('manifest.json')?.toString('utf8') ?? '{}');
    const modules = new Set(manifest.parts.map((p: Json) => p.module));
    for (const m of ['todos', 'notes', 'meetings', 'orders']) expect(modules).toContain(m);
    // The sample's owners read their own records (BUSINESS_ACCESS): the export never widens that.
    expect(records(zip, 'todos.json')).toEqual([
      expect.objectContaining({ title: 'Order tiles', cost: 25_000 }),
    ]);
    expect(records(zip, 'notes.json')).toEqual([
      expect.objectContaining({ title: 'Tile colours', body: 'Grey, matte' }),
    ]);
    const csv = zip.get('todos.csv')?.toString('utf8') ?? '';
    expect(csv.split('\r\n')[0]).toContain('cost');
    const all = [...zip.values()].map((b) => b.toString('utf8')).join('\n');
    expect(all).not.toContain('Someone else');
  });

  it('ops may not export', async () => {
    const res = await ops.call('POST', '/api/exports', {}, here());
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('needs_data_export');
  });

  it('a business role lets ops export: every to-do, never the cost', async () => {
    const role = await owner.call('POST', '/api/members/roles', {
      name: 'exporter',
      label: { en: 'Exporter' },
      capabilities: ['data.export'],
    });
    expect(role.status).toBe(200);
    expect(
      (await owner.call('PATCH', `/api/members/${ops.id}`, { roles: ['ops', 'exporter'] })).status,
    ).toBe(200);
    const zip = await exported(ops, { only: ['todo'] });
    const todos = records(zip, 'todos.json');
    expect(todos.map((t) => t.title).sort()).toEqual(['Book the van', 'Order tiles']);
    for (const t of todos) expect(t).not.toHaveProperty('cost');
    const header = (zip.get('todos.csv')?.toString('utf8') ?? '').split('\r\n')[0];
    expect(header).not.toContain('cost');
    expect([...zip.keys()].sort()).toEqual(['manifest.json', 'todos.csv', 'todos.json']);
  });
});
