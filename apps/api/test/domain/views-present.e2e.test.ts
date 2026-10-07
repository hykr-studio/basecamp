// The agent never sends components: tool results carry an intent naming a registered view and
// a query. The surfaces a turn declares decide how it is shown.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, shutdown } from '../support.js';

const ana = new Person('Ana Present');
const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await boot();
  await ana.signUp();
  await ana.call('POST', '/api/todos', { title: 'Order tiles', dueOn: soon });
  await ana.call('POST', '/api/todos', { title: 'Call the plumber', dueOn: soon });
});
afterAll(shutdown);

describe('present intents', () => {
  it('on the app: a view and a query, which the client fetches with its own session', async () => {
    const res = await ana.chat("what's due this week", undefined, ['inline', 'canvas']);
    const [list] = res.body.toolCalls;
    expect(list).toMatchObject({
      tool: 'list-todos',
      outcome: 'done',
      present: { kind: 'inline', view: 'todo.list', query: { done: false, sort: 'dueOn' } },
    });
    expect(list.present.query.dueOn).toEqual({ lte: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    // One line from the model; the list is the component's job.
    expect(res.body.reply).toMatch(/^2 to-dos due by/);
  });

  it('on a channel without a screen: the same view, rendered to words by the server', async () => {
    const res = await ana.chat("what's due this week", undefined, ['text']);
    const [list] = res.body.toolCalls;
    expect(list.present.kind).toBe('text');
    expect(list.present.text).toContain('• Order tiles (due');
    expect(list.present.text).toContain('• Call the plumber');
    expect(res.body.toolCalls.map((c: { tool: string }) => c.tool)).not.toContain('canvas-open');
  });

  it('voice gets the short form', async () => {
    const res = await ana.chat("what's due this week", undefined, ['voice']);
    expect(res.body.toolCalls[0].present.text).toMatch(/^2 to-dos: /);
  });

  it('streams the intent with the tool output', async () => {
    const res = await ana.stream("what's due this week", ['inline']);
    const output = res.events.find((e) => e.type === 'tool-output-available') as {
      output: { present: { kind: string; view: string } };
    };
    expect(output.output.present).toMatchObject({ kind: 'inline', view: 'todo.list' });
  });

  it('a parked write shows the approval card', async () => {
    const res = await ana.chat('delete Order tiles', undefined, ['inline']);
    const parked = res.body.toolCalls.find((c: { tool: string }) => c.tool === 'delete-todo');
    expect(parked.present).toEqual({
      kind: 'inline',
      view: 'approval.card',
      props: { approvalId: parked.approvalId, summary: 'Delete "Order tiles"' },
    });
  });
});
