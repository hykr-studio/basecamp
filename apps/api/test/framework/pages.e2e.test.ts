// The framework's own features, with no domain: saved pages (a plain entity), the canvas
// tools and present intents across surfaces. Everything here uses only platform views
// (kpi.row, page.list) and platform scripts, so it passes with any domain plugged in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, shutdown } from '../support.js';

const ana = new Person('Ana Platform');
const bob = new Person('Bob Platform');
const APP = ['inline', 'canvas'];
type Call = {
  tool: string;
  ok: boolean;
  outcome: string;
  detail?: string;
  present?: Record<string, unknown>;
};
const tools = (body: { toolCalls: Call[] }) => body.toolCalls.map((c) => c.tool);

/** A page made only of a platform view: no domain entity behind it. */
const page = {
  title: 'Numbers',
  layout: 'stack',
  blocks: [{ id: 'kpis', view: 'kpi.row', props: { items: [{ label: 'Open', value: 3 }] } }],
};

beforeAll(async () => {
  await boot();
  await ana.signUp();
  await bob.signUp();
});
afterAll(shutdown);

describe('saved pages', () => {
  it('"save this as" saves the page on the canvas, as the assistant, for that person only', async () => {
    const res = await ana.chat('save this as Focus board', { canvas: { page } }, APP);
    expect(tools(res.body)).toEqual(['create-page']);
    const [saved] = (await ana.call('GET', '/api/pages?name[contains]=focus')).body.items;
    expect(saved).toMatchObject({
      name: 'Focus board',
      createdBy: 'assistant',
      spec: { title: 'Numbers' },
    });
    expect((await bob.call('GET', `/api/pages/${saved.id}`)).status).toBe(404);
  });

  it('a layout outside the registry is refused, from the API or the assistant', async () => {
    const bad = { ...page, blocks: [{ id: 'x', view: 'no.such.view' }] };
    const api = await ana.call('POST', '/api/pages', { name: 'Bad', spec: bad });
    expect(api.status).toBe(403);
    expect(api.body.reason).toContain('no view called no.such.view');
    const chat = await ana.chat('save this as Bad', { canvas: { page: bad } }, APP);
    expect(chat.body.toolCalls[0]).toMatchObject({ tool: 'create-page', outcome: 'refused' });
  });

  it('without a canvas there is nothing to save', async () => {
    const res = await ana.chat('save this as Nothing', undefined, ['text']);
    expect(tools(res.body)).toEqual([]);
  });
});

describe('present intents by surface', () => {
  it('on the app: a list is a view and a query; opening is a canvas intent', async () => {
    const res = await ana.chat('open my Focus board page', undefined, APP);
    expect(tools(res.body)).toEqual(['list-pages', 'canvas-open']);
    expect(res.body.toolCalls[0].present).toMatchObject({ kind: 'inline', view: 'page.list' });
    expect(res.body.toolCalls[1].present).toMatchObject({ kind: 'open', screen: 'page.view' });
  });

  it('inline only: no canvas tools, so nothing opens', async () => {
    const res = await ana.chat('open my Focus board page', undefined, ['inline']);
    expect(tools(res.body)).toEqual(['list-pages']);
  });

  it('text: the same list in words, and no screen mentioned', async () => {
    const res = await ana.chat('open my Focus board page', undefined, ['text']);
    expect(res.body.toolCalls[0].present).toEqual({
      kind: 'text',
      text: 'Your pages\n• Focus board',
      choices: [{ id: expect.any(String), title: 'Focus board' }],
    });
    expect(res.body.reply).not.toMatch(/canvas|screen|opened/i);
  });

  it('voice: the short form', async () => {
    const res = await ana.chat('open my Focus board page', undefined, ['speech']);
    expect(res.body.toolCalls[0].present.text).toBe('1 saved page: Focus board.');
  });
});

describe('spoken turns with a screen', () => {
  const SPOKEN = ['inline', 'canvas', 'speech'];
  it('the screen shows the view, and the model gets the short form in the turn’s language', async () => {
    const res = await ana.call('POST', '/api/chat/once', {
      message: 'open my Focus board page',
      surfaces: SPOKEN,
      lang: 'te',
    });
    const [list, open] = res.body.toolCalls;
    expect(list.present).toMatchObject({ kind: 'inline', view: 'page.list' });
    expect(list.speech).toBe('1 సేవ్ చేసిన పేజీ: Focus board.');
    expect(open.present).toMatchObject({ kind: 'open', screen: 'page.view' });
    expect(open.speech).toBe('నేను దీన్ని స్క్రీన్‌పై చూపించాను.');
  });

  it('without speech, nothing extra is said', async () => {
    const res = await ana.chat('open my Focus board page', undefined, APP);
    expect(res.body.toolCalls[0].speech).toBeUndefined();
  });
});
