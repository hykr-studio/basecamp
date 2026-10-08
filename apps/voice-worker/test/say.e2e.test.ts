// The voice path end to end, minus audio: the worker's own code (language, turn, relay) against
// the real API, booted in-process from its build like the API's own e2e suite does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, pool, shutdown } from '../../api/test/support.js';
import { say } from '../src/say.js';

const ravi = new Person('Ravi Voice Worker');
let threadId = '';
let room = '';

beforeAll(async () => {
  await boot();
  await ravi.signUp();
  // The worker acts only inside a session the API opened for the person.
  const session = (await ravi.call('POST', '/api/voice/session', {})).body;
  threadId = session.threadId;
  room = session.room;
});
afterAll(shutdown);

const person = () => ({ userId: ravi.id, threadId, room, timeZone: 'Asia/Kolkata' });

describe('say (fake voice)', () => {
  it('Telugu: జోడించు adds the to-do, the reply is Telugu, the screen gets the tool part', async () => {
    const turn = await say({ person: person(), text: 'జోడించు Call the plumber', lang: 'auto' });
    expect(turn.lang).toBe('te');
    expect(turn.spoken).toBe('"Call the plumber" జోడించాను.');
    expect(turn.uiParts).toEqual([
      expect.objectContaining({
        type: 'tool-create-todo',
        state: 'output-available',
        input: { title: 'Call the plumber' },
        output: expect.objectContaining({ ok: true }),
      }),
    ]);
    const { rows } = await pool.query(
      `select actor_id, acting_for, channel from audit.events where action = 'todo.create' and run_id = $1`,
      [turn.runId],
    );
    expect(rows).toEqual([{ actor_id: 'assistant', acting_for: ravi.id, channel: 'voice' }]);
  });

  it('Hindi delete by voice parks an approval card for the screen; nothing is deleted', async () => {
    const turn = await say({ person: person(), text: 'Call the plumber हटाओ', lang: 'hi-IN' });
    expect(turn.spoken).toBe('इसके लिए आपकी मंज़ूरी चाहिए। मैंने इसे स्क्रीन पर दिखा दिया है।');
    const card = turn.uiParts.find((p) => p.type === 'tool-delete-todo');
    expect(card?.output).toMatchObject({
      present: { kind: 'inline', view: 'approval.card' },
      result: { status: 'needs_approval' },
    });
    const todos = (await ravi.call('GET', '/api/todos')).body.items;
    expect(todos.map((t: { title: string }) => t.title)).toEqual(['Call the plumber']);
  });

  it('spoken turns join the same thread the app shows', async () => {
    const messages = (await ravi.call('GET', `/api/threads/${threadId}/messages`)).body;
    expect(
      messages.map((m: { role: string; metadata: { channel: string } }) => [
        m.role,
        m.metadata.channel,
      ]),
    ).toEqual([
      ['user', 'voice'],
      ['assistant', 'voice'],
      ['user', 'voice'],
      ['assistant', 'voice'],
    ]);
  });
});
