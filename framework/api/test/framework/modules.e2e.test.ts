// The fixture as two modules (tasks, visits), booted: each module's routes serve, its specs carry
// its id, another business still gets a 404 on a module's record, an agent's parked write is
// audited, and `basecamp eval --module` runs one module's evals on their own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEval, runtime } from '../../dist/index.js';
import { asAssistant, boot, Person, pool, shutdown } from '../../dist/testing.js';
import { RescheduleVisitSpec, TaskSpec, VisitSpec } from '../fixture/dist/contracts.js';
import { fixture } from '../fixture/dist/index.js';

const ana = new Person('Ana Modules');
const bob = new Person('Bob Modules');
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

beforeAll(async () => {
  await boot(fixture);
  await ana.signUp();
  await bob.signUp();
});
afterAll(shutdown);

describe('modules, booted', () => {
  it("serves each module's entities and commands", async () => {
    const task = await ana.call('POST', '/api/tasks', { title: 'From the tasks module' });
    expect(task.status).toBe(201);
    const visit = await ana.call('POST', '/api/visits', {
      title: 'From the visits module',
      startsAt: at(24),
      endsAt: at(25),
    });
    expect(visit.status).toBe(201);
    const moved = await ana.call('POST', `/api/visits/${visit.body.value.id}/reschedule`, {
      startsAt: at(48),
      endsAt: at(49),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe('done');
  });

  it('stamps every spec with its module, and the running catalog says which', () => {
    expect(TaskSpec.module).toBe('tasks');
    expect(VisitSpec.module).toBe('visits');
    expect(RescheduleVisitSpec.module).toBe('visits');
    const { catalog } = runtime();
    expect(catalog.moduleOf('task')).toBe('tasks');
    expect(catalog.moduleOf('visits')).toBe('visits');
    expect(catalog.toolModule('reschedule-visit')).toBe('visits');
    expect(catalog.toolModule('create-task')).toBe('tasks');
    expect(catalog.entities.pages.module).toBe('platform');
  });

  it("keeps another business out of a module's records: 404, never 403", async () => {
    const visit = await ana.call('POST', '/api/visits', {
      title: 'Ana only',
      startsAt: at(2),
      endsAt: at(3),
    });
    const id = visit.body.value.id;
    expect((await bob.call('GET', `/api/visits/${id}`)).status).toBe(404);
    expect(
      (await bob.call('POST', `/api/visits/${id}/reschedule`, { startsAt: at(5), endsAt: at(6) }))
        .status,
    ).toBe(404);
    const list = await bob.call('GET', '/api/visits');
    expect(list.body.items.map((v: { id: string }) => v.id)).not.toContain(id);
  });

  it("parks an agent's delete in a module and audits it", async () => {
    const task = await ana.call('POST', '/api/tasks', { title: 'Parked by the agent' });
    const id = task.body.value.id;
    const res = await asAssistant(`user:${ana.id}`, { 'x-channel': 'app' })(
      'DELETE',
      `/api/tasks/${id}`,
    );
    expect(res.body.status).toBe('needs_approval');
    const { rows } = await pool.query(
      `select action, outcome, actor_kind from audit.events where resource_id = $1 order by at`,
      [id],
    );
    expect(rows.at(-1)).toMatchObject({
      action: 'task.delete',
      outcome: 'needs_approval',
      actor_kind: 'agent',
    });
    expect((await ana.call('GET', `/api/tasks/${id}`)).status).toBe(200);
  });
});

describe('basecamp eval --module', () => {
  it("runs one module's evals, with a fresh user and that module's setup", async () => {
    expect(await runEval(fixture, 'assistant', { module: 'tasks' })).toBe(true);
  });

  it('fails a module with no cases, and an unknown module', async () => {
    expect(await runEval(fixture, 'assistant', { module: 'visits' })).toBe(false);
    await expect(runEval(fixture, 'assistant', { module: 'nowhere' })).rejects.toThrow(
      'No module called nowhere (modules: tasks, visits)',
    );
  });
});
