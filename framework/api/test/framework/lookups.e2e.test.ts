// A lookup is not the answer (V13). The assistant reads before it writes ("delete Buy milk":
// list-tasks, then delete-task): the list was how it found the task, so no channel shows it beside
// the change: not WhatsApp's words, not the app's view, not the saved thread. A read with no
// change after it is the answer, and shows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toRenderTurn } from '../../dist/channels/whatsapp/turn.js';
import { boot, Person, shutdown } from '../../dist/testing.js';
import { fixture } from '../fixture/dist/index.js';

const ana = new Person('Ana Lookups');

type Call = { tool: string; outcome: string; present?: { kind: string; view?: string } };
type Part = { type: string; output?: { present?: unknown } };

beforeAll(async () => {
  await boot(fixture);
  await ana.signUp();
  for (const title of ['Buy milk', 'Buy bread', 'Buy eggs'])
    expect((await ana.call('POST', '/api/tasks', { title })).status).toBeLessThan(300);
});
afterAll(shutdown);

/** The tool parts of the thread's last reply, as the app renders it when reloaded. */
async function savedParts(threadId: string): Promise<Part[]> {
  const messages = (await ana.call('GET', `/api/threads/${threadId}/messages`)).body as {
    role: string;
    parts: Part[];
  }[];
  return (messages.at(-1)?.parts ?? []).filter((p) => p.type.startsWith('tool-'));
}

describe('a lookup before a change', () => {
  it('on WhatsApp (words only): the reply and the request, never the list', async () => {
    const turn = await ana.chat('delete Buy milk');
    expect(turn.status).toBe(200);
    const calls = turn.body.toolCalls as Call[];
    expect(calls.map((c) => `${c.tool}:${c.outcome}`)).toEqual([
      'list-tasks:done',
      'delete-task:parked',
    ]);
    expect(calls[0]).not.toHaveProperty('present');
    // What WhatsApp sends: the waiting line, no list after it.
    expect(toRenderTurn(turn.body).views).toEqual([]);
    const saved = await savedParts(turn.body.threadId);
    expect(saved.map((p) => p.type)).toEqual(['tool-list-tasks', 'tool-delete-task']);
    expect(saved[0].output).not.toHaveProperty('present');
  });

  it('on a screen: the approval card, never the list above it', async () => {
    const turn = await ana.chat('delete Buy bread', undefined, ['inline']);
    const calls = turn.body.toolCalls as Call[];
    expect(calls[0]).toMatchObject({ tool: 'list-tasks', outcome: 'done' });
    expect(calls[0]).not.toHaveProperty('present');
    expect(calls[1]).toMatchObject({
      tool: 'delete-task',
      outcome: 'parked',
      present: { kind: 'inline', view: 'approval.card' },
    });
    const saved = await savedParts(turn.body.threadId);
    expect(saved[0].output).not.toHaveProperty('present');
    expect(saved[1].output).toHaveProperty('present');
  });
});

describe('a lookup before what it found', () => {
  it('on a screen with a canvas: "open my <page> view" opens the page, with no pages list', async () => {
    const spec = {
      title: 'Monday',
      layout: 'stack',
      blocks: [{ id: 'k', view: 'kpi.row', props: { items: [{ label: 'Open', value: 1 }] } }],
    };
    expect((await ana.call('POST', '/api/pages', { name: 'Monday', spec })).status).toBeLessThan(
      300,
    );
    const turn = await ana.chat('open my Monday view', undefined, ['inline', 'canvas']);
    const calls = turn.body.toolCalls as Call[];
    expect(calls.map((c) => `${c.tool}:${c.outcome}`)).toEqual([
      'list-pages:done',
      'canvas-open:done',
    ]);
    expect(calls[0]).not.toHaveProperty('present');
    expect(calls[1].present).toMatchObject({ kind: 'open', screen: 'page.view' });
    const saved = await savedParts(turn.body.threadId);
    expect(saved[0].output).not.toHaveProperty('present');
    expect(saved[1].output).toHaveProperty('present');
  });
});

describe('a read with no change after it', () => {
  it('is the answer: it shows', async () => {
    // Nothing by that title: the list is what the assistant read, and nothing was changed.
    const turn = await ana.chat('delete Buy nothing');
    const calls = turn.body.toolCalls as Call[];
    expect(calls.map((c) => c.tool)).toEqual(['list-tasks']);
    expect(calls[0].present).toMatchObject({ kind: 'text' });
    expect(toRenderTurn(turn.body).views).toHaveLength(1);
  });
});
