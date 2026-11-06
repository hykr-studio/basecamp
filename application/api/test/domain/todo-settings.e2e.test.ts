// The to-dos module's settings demo (A11): a business's own `priority` field on to-dos, and the
// `todos.clear-done` flag that the business switches on before "clear done to-dos" works.
import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Priority');
const staff = new Person('Staff Priority');
const stranger = new Person('Stranger Priority');
let tenantId = '';

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
});
afterAll(shutdown);

const titles = async (who: Person, query: string) =>
  (await who.call('GET', `/api/todos?${query}`)).body.items.map((t: { title: string }) => t.title);

describe('a priority on to-dos (a custom field the business defines)', () => {
  let fieldId = '';

  it('the owner adds the field; staff cannot; another business never sees it', async () => {
    const field = {
      entity: 'todo',
      key: 'priority',
      type: 'select',
      label: { en: 'Priority', hi: 'प्राथमिकता', te: 'ప్రాధాన్యత' },
      options: ['low', 'medium', 'high'],
    };
    const refused = await staff.call('POST', '/api/custom-fields', field, {
      'x-tenant-id': tenantId,
    });
    expect(refused.status).toBe(403);
    const made = await owner.call('POST', '/api/custom-fields', field);
    expect(made.status).toBe(201);
    fieldId = made.body.value.id;
    expect((await stranger.call('GET', `/api/custom-fields/${fieldId}`)).status).toBe(404);
  });

  it('to-dos carry it, checked against its options, and lists filter on it', async () => {
    const high = await owner.call('POST', '/api/todos', {
      title: 'Fix the leak',
      custom: { priority: 'high' },
    });
    expect(high.status).toBe(201);
    expect(high.body.value.custom).toEqual({ priority: 'high' });
    await owner.call('POST', '/api/todos', {
      title: 'Water the plants',
      custom: { priority: 'low' },
    });
    await owner.call('POST', '/api/todos', { title: 'No priority yet' });
    const wrong = await owner.call('POST', '/api/todos', {
      title: 'Bad',
      custom: { priority: 'now' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: 'custom_field_invalid' });
    expect(await titles(owner, 'custom[priority]=high')).toEqual(['Fix the leak']);
    const stranger400 = await stranger.call('GET', '/api/todos?custom[priority]=high');
    expect(stranger400.status).toBe(400);
  });

  it("the assistant's create with a priority waits like any other; the field is turn context", async () => {
    const agent = asAssistant(`user:${owner.id}`, { 'x-tenant-id': tenantId });
    const made = await agent('POST', '/api/todos', {
      title: 'From the assistant',
      custom: { priority: 'medium' },
    });
    expect(made.status).toBe(201);
    expect(made.body.value).toMatchObject({ custom: { priority: 'medium' } });
    const { rows } = await pool.query(
      "select actor_kind from audit.events where action = 'todo.create' and tenant_id = $1 and actor_kind = 'agent'",
      [tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('"clear done to-dos": behind a flag the business switches', () => {
  it('is off: the route is 404 and the assistant does not get the tool', async () => {
    await owner
      .call('POST', '/api/todos', { title: 'Old task' })
      .then((r) => owner.call('PATCH', `/api/todos/${r.body.value.id}`, { done: true }));
    expect((await owner.call('POST', '/api/todos/clear-done', {})).status).toBe(404);
    expect((await me(owner)) as unknown).toMatchObject({ features: [] });
    const turn = await owner.chat('clear done to-dos');
    expect(turn.status).toBe(200);
    expect(turn.body.toolCalls ?? []).not.toContainEqual(
      expect.objectContaining({ tool: 'clear-done-todos', ok: true }),
    );
    expect(await titles(owner, 'done=true')).toEqual(['Old task']);
  });

  it('the owner switches it on; then the assistant asks first, and the person clears at once', async () => {
    expect(
      (
        await staff.call(
          'PUT',
          '/api/features/todos.clear-done',
          { on: true },
          { 'x-tenant-id': tenantId },
        )
      ).status,
    ).toBe(403);
    expect((await owner.call('PUT', '/api/features/todos.clear-done', { on: true })).status).toBe(
      200,
    );
    expect((await me(owner)) as unknown).toMatchObject({ features: ['todos.clear-done'] });
    const turn = await owner.chat('clear done to-dos');
    expect(turn.body.toolCalls).toEqual([
      expect.objectContaining({ tool: 'clear-done-todos', ok: true, outcome: 'parked' }),
    ]);
    const cleared = await owner.call('POST', '/api/todos/clear-done', {});
    expect(cleared.body).toMatchObject({ status: 'done', value: { cleared: 1 } });
    expect(await titles(owner, 'done=true')).toEqual([]);
    // Another business still has it off.
    expect((await stranger.call('POST', '/api/todos/clear-done', {})).status).toBe(404);
  });
});
