// The canvas: the assistant opens screens and composes pages of views, all validated against
// the registry and filled with the person's own session. Saved pages are a plain entity.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, pool, shutdown } from '../support.js';

const ana = new Person('Ana Canvas');
const bob = new Person('Bob Canvas');
const APP = ['inline', 'canvas'];
const tools = (body: { toolCalls: { tool: string }[] }) => body.toolCalls.map((c) => c.tool);
type Call = {
  tool: string;
  ok: boolean;
  outcome: string;
  detail?: string;
  present?: Record<string, unknown>;
};

let siteReview: { id: string };
const page = {
  title: 'My week',
  layout: 'two-column',
  blocks: [
    { id: 'todos', view: 'todo.list', props: { title: 'Due this week' }, query: { done: false } },
    { id: 'prep', view: 'meeting.list', query: { status: 'scheduled' } },
  ],
};

beforeAll(async () => {
  await boot();
  await ana.signUp();
  await bob.signUp();
  const start = new Date(Date.now() + 3_600_000);
  siteReview = (
    await ana.call('POST', '/api/meetings', {
      title: 'Site review',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    })
  ).body.value;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await ana.call('POST', '/api/todos', { title: 'Pay the electrician', dueOn: yesterday });
});
afterAll(shutdown);

describe('canvas tools', () => {
  it('open: a registered screen, by id', async () => {
    const res = await ana.chat('open Site review', undefined, APP);
    expect(tools(res.body)).toEqual(['list-meetings', 'canvas-open']);
    const open = res.body.toolCalls[1] as Call;
    expect(open.present).toEqual({
      kind: 'open',
      screen: 'meeting.detail',
      params: { id: siteReview.id },
    });
  });

  it('exist only where a canvas can show them', async () => {
    const res = await ana.chat('open Site review', undefined, ['inline']);
    expect(tools(res.body)).toEqual(['list-meetings', 'get-meeting']);
    const text = await ana.chat('plan my week', undefined, ['text']);
    expect(tools(text.body)).toEqual(['list-meetings', 'list-todos', 'list-meetings']);
    expect(text.body.reply).not.toMatch(/canvas|screen|opened/i);
    expect((text.body.toolCalls[1] as Call).present?.kind).toBe('text');
  });

  it('compose: a page of queries, checked against the registry', async () => {
    const res = await ana.chat('plan my week', undefined, APP);
    const compose = res.body.toolCalls[0] as Call & {
      present: { kind: string; page: { blocks: { view: string }[] } };
    };
    expect(compose.tool).toBe('canvas-compose');
    expect(compose.present.kind).toBe('page');
    expect(compose.present.page.blocks.map((b) => b.view)).toEqual([
      'calendar.week',
      'todo.list',
      'meeting.list',
    ]);
  });

  it('patch: changes one block of the page the person has open', async () => {
    const res = await ana.chat('only overdue', { screen: 'today', canvas: { page } } as never, APP);
    const patch = res.body.toolCalls[0] as Call;
    expect(patch.tool).toBe('canvas-patch');
    expect(patch.present).toMatchObject({
      kind: 'patch',
      blockId: 'todos',
      query: { done: false, dueOn: { lt: expect.any(String) } },
    });
  });

  it('a bad view or query is a tool error the model sees, never something the client gets', async () => {
    const bad = {
      ...page,
      blocks: [{ id: 'users', view: 'todo.list', query: { ownerId: 'everyone' } }],
    };
    // "save this as" with a forged page: the entity rule refuses it with bad_spec.
    const saved = await ana.chat(
      'save this as Everyone',
      { screen: 'today', canvas: { page: bad } } as never,
      APP,
    );
    const create = saved.body.toolCalls[0] as Call;
    expect(create).toMatchObject({ tool: 'create-page', ok: false, outcome: 'refused' });
    expect(create.detail).toContain('Page layout is invalid');
  });
});

describe('saved pages', () => {
  it('"save this as" is a plain create; the page belongs to the person and holds queries', async () => {
    const res = await ana.chat(
      'save this as Monday view',
      { screen: 'today', canvas: { page } } as never,
      APP,
    );
    expect(tools(res.body)).toEqual(['create-page']);
    expect(res.body.reply).toBe('Saved "Monday view". It is under Pages.');
    const list = await ana.call('GET', '/api/pages?name[contains]=monday');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      name: 'Monday view',
      createdBy: 'assistant',
      spec: { title: 'My week' },
    });
    // Not Bob's.
    expect((await bob.call('GET', '/api/pages')).body.items).toEqual([]);
    expect((await bob.call('GET', `/api/pages/${list.body.items[0].id}`)).status).toBe(404);
  });

  it('opens by name in the canvas', async () => {
    const res = await ana.chat('open my Monday view', undefined, APP);
    expect(tools(res.body)).toEqual(['list-pages', 'canvas-open']);
    expect((res.body.toolCalls[1] as Call).present).toMatchObject({
      kind: 'open',
      screen: 'page.view',
    });
  });

  it('the person saves pages through the same API; a layout outside the registry is refused', async () => {
    const ok = await ana.call('POST', '/api/pages', { name: 'Focus', spec: page });
    expect(ok.body.status).toBe('done');
    const bad = await ana.call('POST', '/api/pages', {
      name: 'Bad',
      spec: { ...page, blocks: [{ id: 'x', view: 'approval.card', props: { approvalId: 'a' } }] },
    });
    expect(bad.status).toBe(403);
    expect(bad.body.reason).toContain('cannot be shown on a page');
    // Renaming and deleting stay the person's: the agent has no tools for them.
    const agentTools = await ana.chat('list', undefined, APP);
    expect(tools(agentTools.body)).not.toContain('delete-page');
  });
});

describe('taps in rendered views', () => {
  it("are the person's own actions in the audit trail, not the agent's", async () => {
    // A view's act('toggle') sends this request with the person's session.
    const todo = (await ana.call('GET', '/api/todos?title[contains]=electrician')).body.items[0];
    await ana.call('PATCH', `/api/todos/${todo.id}`, { done: true });
    const { rows } = await pool.query(
      `select actor_kind from audit.events where resource_id = $1 and action = 'todo.update'`,
      [todo.id],
    );
    expect(rows.map((r) => r.actor_kind)).toEqual(['user']);
  });
});
