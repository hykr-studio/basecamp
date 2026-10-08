// Threads and relays, with no domain: the server keeps the conversation, every channel shares
// it, and the voice worker (a relay with its own key) starts turns for the person it acts for.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, pool, server, shutdown } from '../support.js';

const ana = new Person('Ana Threads');
const bob = new Person('Bob Threads');
const page = {
  title: 'Numbers',
  layout: 'stack',
  blocks: [{ id: 'kpis', view: 'kpi.row', props: { items: [{ label: 'Open', value: 3 }] } }],
};

/** The voice worker's headers: its own key, the person, the session's room, a run per call. */
const voiceHeaders = (
  userId: string,
  room: string,
  key = process.env.VOICE_AGENT_KEY ?? '',
  id = 'voice',
) => ({
  'content-type': 'application/json',
  'x-agent-key': key,
  'x-agent-id': id,
  'x-acting-for': userId,
  'x-voice-room': room,
  'x-run-id': randomUUID().replaceAll('-', ''),
});

/** Ana's open voice session (the worker may only act inside one). */
let room = '';

/** A turn as the voice worker starts it, inside Ana's session unless told otherwise. */
const asVoice = (
  userId: string,
  body: object,
  key = process.env.VOICE_AGENT_KEY ?? '',
  id = 'voice',
  inRoom = room,
) =>
  fetch(`${server.base}/api/chat/once`, {
    method: 'POST',
    headers: voiceHeaders(userId, inRoom, key, id),
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await boot();
  await ana.signUp();
  await bob.signUp();
});
afterAll(shutdown);

describe('threads', () => {
  it('turns continue the current thread, and the server keeps both sides', async () => {
    const first = await ana.chat('open my Nothing page', undefined, ['inline']);
    const second = await ana.chat('save this as Board', { canvas: { page } }, ['inline', 'canvas']);
    expect(second.body.threadId).toBe(first.body.threadId);
    const current = await ana.call('GET', '/api/threads/current');
    expect(current.body.id).toBe(first.body.threadId);

    const messages = (await ana.call('GET', `/api/threads/${first.body.threadId}/messages`)).body;
    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    // A reply renders as it streamed: its tool call with the output, then its text.
    const reply = messages[3];
    expect(reply.parts[0]).toMatchObject({
      type: 'tool-create-page',
      state: 'output-available',
      output: { ok: true },
    });
    expect(reply.parts.at(-1)).toEqual({ type: 'text', text: 'Saved "Board". It is under Pages.' });
    expect(reply.metadata).toMatchObject({ channel: 'app', runId: second.body.runId });
  });

  it('are private: another person gets 404, and cannot continue it', async () => {
    const { body } = await ana.call('GET', '/api/threads/current');
    expect((await bob.call('GET', `/api/threads/${body.id}/messages`)).status).toBe(404);
    const res = await bob.call('POST', '/api/chat/once', { threadId: body.id, message: 'hello' });
    expect(res.status).toBe(404);
  });

  it('a new thread starts empty and becomes the current one', async () => {
    const fresh = (await ana.call('POST', '/api/threads')).body;
    expect((await ana.call('GET', '/api/threads/current')).body.id).toBe(fresh.id);
    expect((await ana.call('GET', `/api/threads/${fresh.id}/messages`)).body).toEqual([]);
  });
});

describe('relays (the voice worker)', () => {
  beforeAll(async () => {
    room = (await ana.call('POST', '/api/voice/session', {})).body.room;
  });

  it('start a turn for the person they act for; the turn and its writes say voice', async () => {
    const res = await asVoice(ana.id, {
      message: 'save this as Spoken board',
      surfaces: ['inline', 'canvas', 'speech'],
      context: { canvas: { page } },
    });
    expect(res.status).toBe(200);
    const turn = await res.json();
    expect(turn.toolCalls[0]).toMatchObject({ tool: 'create-page', outcome: 'done' });
    // Saved in Ana's thread, marked as spoken.
    const messages = (await ana.call('GET', `/api/threads/${turn.threadId}/messages`)).body;
    expect(messages.at(-2)).toMatchObject({ role: 'user', metadata: { channel: 'voice' } });
    // The write was the assistant's, for Ana, in this voice turn.
    const { rows } = await pool.query(
      `select actor_kind, actor_id, acting_for, channel, run_id from audit.events where action = 'page.create' and run_id = $1`,
      [turn.runId],
    );
    expect(rows).toEqual([
      {
        actor_kind: 'agent',
        actor_id: 'assistant',
        acting_for: ana.id,
        channel: 'voice',
        run_id: turn.runId,
      },
    ]);
  });

  it("the assistant's own key cannot start a turn, and a relay cannot do anything else", async () => {
    const assistant = await asVoice(
      ana.id,
      { message: 'hi' },
      process.env.AGENT_API_KEY ?? '',
      'assistant',
    );
    expect(assistant.status).toBe(403);
    // Not data, not approvals: its key opens a turn and nothing else, even in a session.
    for (const path of ['/api/approvals', '/api/pages', '/api/threads/current']) {
      const res = await fetch(`${server.base}${path}`, { headers: voiceHeaders(ana.id, room) });
      expect(res.status, path).toBe(403);
    }
  });

  it('acts only inside an open session of that person, in its thread', async () => {
    // No session, someone else's session, or one that has ended: refused.
    expect((await asVoice(ana.id, { message: 'hi' }, undefined, undefined, '')).status).toBe(403);
    const bobs = (await bob.call('POST', '/api/voice/session', {})).body.room;
    expect((await asVoice(ana.id, { message: 'hi' }, undefined, undefined, bobs)).status).toBe(403);
    const ended = (await ana.call('POST', '/api/voice/session', {})).body.room;
    const end = await fetch(`${server.base}/api/voice/end`, {
      method: 'POST',
      headers: voiceHeaders(ana.id, ended),
      body: JSON.stringify({ room: ended, seconds: 3, turns: 0 }),
    });
    expect(end.status).toBe(204);
    expect((await asVoice(ana.id, { message: 'hi' }, undefined, undefined, ended)).status).toBe(
      403,
    );
  });

  it('a key and an id must match: the voice key cannot claim to be the assistant', async () => {
    const res = await asVoice(
      ana.id,
      { message: 'hi' },
      process.env.VOICE_AGENT_KEY ?? '',
      'assistant',
    );
    expect(res.status).toBe(401);
  });

  it('cannot reach a thread other than its session’s', async () => {
    const bobs = (await bob.call('GET', '/api/threads/current')).body;
    const res = await asVoice(ana.id, { threadId: bobs.id, message: 'hi' });
    expect(res.status).toBe(403);
  });
});
