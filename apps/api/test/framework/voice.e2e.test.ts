// Voice sessions, with no domain: who may start one, what the token allows, the worker's
// report at the end, and the daily budget. The audio never touches the API.
import { TokenVerifier } from 'livekit-server-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, pool, server, shutdown } from '../support.js';

const asha = new Person('Asha Voice');
const kiran = new Person('Kiran Voice');

const asWorker = (userId: string, path: string, body: object, id = 'voice') =>
  fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-key': process.env.VOICE_AGENT_KEY ?? '',
      'x-agent-id': id,
      'x-acting-for': userId,
      'x-run-id': `voice-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await boot();
  await asha.signUp();
  await kiran.signUp();
});
afterAll(shutdown);

describe('voice sessions', () => {
  it('a person gets a token for one room in their thread, with the voice worker dispatched', async () => {
    const res = await asha.call('POST', '/api/voice/session', {
      lang: 'te-IN',
      timeZone: 'Asia/Kolkata',
    });
    expect(res.status).toBe(201);
    const { url, token, room, threadId } = res.body;
    expect(url).toMatch(/^wss?:\/\//);
    expect(room).toMatch(new RegExp(`^voice:${asha.id}:${threadId}:[0-9a-f]{8}$`));
    // Each session its own room, so LiveKit dispatches the worker every time.
    const again = (await asha.call('POST', '/api/voice/session', {})).body;
    expect(again.room).not.toBe(room);
    expect((await asha.call('GET', '/api/threads/current')).body.id).toBe(threadId);

    const claims = await new TokenVerifier(
      process.env.LIVEKIT_API_KEY ?? 'devkey',
      process.env.LIVEKIT_API_SECRET ?? 'secret',
    ).verify(token);
    expect(claims.sub).toBe(asha.id);
    expect(claims.video).toMatchObject({ room, roomJoin: true, canPublish: true });
    expect(claims.video?.roomAdmin).toBeFalsy();
    const dispatch = claims.roomConfig?.agents?.[0];
    expect(dispatch?.agentName).toBe('voice');
    expect(JSON.parse(dispatch?.metadata ?? '{}')).toEqual({
      threadId,
      lang: 'te-IN',
      timeZone: 'Asia/Kolkata',
      maxSeconds: 1200,
    });

    const { rows } = await pool.query(
      `select actor_kind, actor_id, channel, after from audit.events where action = 'voice.session.start' and after->>'room' = $1`,
      [room],
    );
    expect(rows).toEqual([
      {
        actor_kind: 'user',
        actor_id: asha.id,
        channel: 'voice',
        after: { room, lang: 'te-IN', maxSeconds: 1200 },
      },
    ]);
  });

  it("refuses a thread that is not the person's, and anyone who is not a person", async () => {
    const kirans = (await kiran.call('GET', '/api/threads/current')).body;
    const other = await asha.call('POST', '/api/voice/session', { threadId: kirans.id });
    expect(other.status).toBe(404);
    expect((await new Person('Nobody').call('POST', '/api/voice/session', {})).status).toBe(401);
    expect((await asWorker(asha.id, '/api/voice/session', {})).status).toBe(403);
  });

  it('only the worker reports an end, and only for the person’s own room', async () => {
    const { room } = (await asha.call('POST', '/api/voice/session', {})).body;
    expect((await asha.call('POST', '/api/voice/end', { room, seconds: 5, turns: 1 })).status).toBe(
      403,
    );
    // Acting for someone else: nothing is recorded against either of them.
    await asWorker(kiran.id, '/api/voice/end', { room, seconds: 5, turns: 1 });
    const ok = await asWorker(asha.id, '/api/voice/end', { room, seconds: 42, turns: 3 });
    expect(ok.status).toBe(204);
    // A retried report counts once.
    expect(
      (await asWorker(asha.id, '/api/voice/end', { room, seconds: 42, turns: 3 })).status,
    ).toBe(204);
    const { rows } = await pool.query(
      `select actor_id, acting_for, channel, after from audit.events where action = 'voice.session.end' and acting_for = $1`,
      [asha.id],
    );
    expect(rows).toEqual([
      {
        actor_id: 'voice',
        acting_for: asha.id,
        channel: 'voice',
        after: { room, seconds: 42, turns: 3 },
      },
    ]);
  });

  it("stops at the day's budget with 429; typing still works", async () => {
    // Sessions until the day is spent (each one at most a session's length).
    const limit = Number(process.env.VOICE_DAILY_MINUTES ?? 30) * 60;
    for (let spent = 0; spent < limit; ) {
      const session = await kiran.call('POST', '/api/voice/session', {});
      expect(session.status).toBe(201);
      await asWorker(kiran.id, '/api/voice/end', {
        room: session.body.room,
        seconds: 1200,
        turns: 1,
      });
      spent += 1200;
    }
    const res = await kiran.call('POST', '/api/voice/session', {});
    expect(res.status).toBe(429);
    expect(res.body.reason).toMatch(/voice minutes/);
    expect((await kiran.call('POST', '/api/chat/once', { message: 'hello' })).status).toBe(200);
  });
});
