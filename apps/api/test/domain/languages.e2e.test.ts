// The domain in Hindi and Telugu, with the scripted model: verbs in either language, before
// or after the title; tools called in English; answers in the turn's language.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, pool, shutdown } from '../support.js';

const ravi = new Person('Ravi Languages');
const SPOKEN = ['inline', 'canvas', 'speech'];
const turn = (message: string, extra: object = {}) =>
  ravi.call('POST', '/api/chat/once', { message, surfaces: SPOKEN, ...extra });

beforeAll(async () => {
  await boot();
  await ravi.signUp();
});
afterAll(shutdown);

describe('languages', () => {
  it('Telugu: జోడించు adds the to-do, and the answer is in Telugu', async () => {
    const res = await turn('జోడించు Call the plumber', { lang: 'te' });
    expect(res.body.toolCalls[0]).toMatchObject({ tool: 'create-todo', outcome: 'done' });
    expect(res.body.reply).toBe('"Call the plumber" జోడించాను.');
  });

  it('Hindi, verb last, language detected from the script: the title stays as said', async () => {
    const res = await ravi.call('POST', '/api/chat/once', {
      message: 'Order tiles जोड़ो',
      surfaces: ['inline', 'canvas'],
    });
    expect(res.body.reply).toBe('"Order tiles" जोड़ दिया।');
    const titles = (await ravi.call('GET', '/api/todos')).body.items.map(
      (t: { title: string }) => t.title,
    );
    expect(titles).toContain('Order tiles');
  });

  it('a spoken list says the gist in the language; the checklist is on screen', async () => {
    const res = await turn('జాబితా', { lang: 'te' });
    expect(res.body.toolCalls[0].present).toMatchObject({ kind: 'inline', view: 'todo.list' });
    expect(res.body.reply).toBe('2 పనులు: Call the plumber, Order tiles.');
  });

  it('a delete by voice is parked: the answer says so briefly, and nothing is deleted', async () => {
    const res = await turn('Order tiles हटाओ', { lang: 'hi' });
    expect(res.body.toolCalls.map((c: { outcome: string }) => c.outcome)).toEqual([
      'done',
      'parked',
    ]);
    expect(res.body.reply).toBe('इसके लिए आपकी मंज़ूरी चाहिए। मैंने इसे स्क्रीन पर दिखा दिया है।');
    const { rows } = await pool.query(
      `select count(*)::int as n from app.todos where owner_id = $1 and title = 'Order tiles'`,
      [ravi.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('the language is saved with the turn', async () => {
    const thread = (await ravi.call('GET', '/api/threads/current')).body;
    const messages = (await ravi.call('GET', `/api/threads/${thread.id}/messages`)).body;
    expect(messages[0].metadata.lang).toBe('te');
    expect(messages.at(-1).parts.at(-1).text).toMatch(/मंज़ूरी/);
  });
});
