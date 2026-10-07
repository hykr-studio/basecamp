// The app's chat is an AI SDK UI message stream: tool calls and results arrive as they happen.
// Domain-free: it saves a page made of a platform view.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, shutdown } from '../support.js';

const ana = new Person('Ana Stream');
const page = {
  title: 'Numbers',
  layout: 'stack',
  blocks: [{ id: 'kpis', view: 'kpi.row', props: { items: [{ label: 'Open', value: 3 }] } }],
};

beforeAll(async () => {
  await boot();
  await ana.signUp();
});
afterAll(shutdown);

describe('streaming chat', () => {
  it('streams the turn: tool input, tool output, text, and the run id', async () => {
    const res = await ana.stream('save this as Stream board', ['inline', 'canvas'], {
      canvas: { page },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const runId = res.headers.get('x-run-id');
    expect(runId).toMatch(/^[0-9a-f]{32}$/);

    const types = res.events.map((e) => e.type);
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types).toContain('text-delta');
    const output = res.events.find((e) => e.type === 'tool-output-available') as {
      output: { ok: boolean; result: { status: string } };
    };
    expect(output.output).toMatchObject({ ok: true, result: { status: 'done' } });
    const text = res.events
      .filter((e) => e.type === 'text-delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toContain('Stream board');
    // The run id rides on the message metadata, for the Studio link.
    expect(res.events.some((e) => (e.messageMetadata as { runId?: string })?.runId === runId)).toBe(
      true,
    );
  });

  it('streams the present intent with the tool output', async () => {
    const res = await ana.stream('open my Stream board page', ['inline']);
    const output = res.events.find((e) => e.type === 'tool-output-available') as {
      output: { present: { kind: string; view: string } };
    };
    expect(output.output.present).toMatchObject({ kind: 'inline', view: 'page.list' });
  });

  it('needs a session', async () => {
    const stranger = new Person('No Session');
    const res = await stranger.stream('open my Anything page');
    expect(res.status).toBe(401);
  });
});
