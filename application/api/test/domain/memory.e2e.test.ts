// Notes are memory of their meeting (A8): the assistant recalls them by meaning, for whoever may
// read the note and its meeting; the business's own memory sits beside them. Against the real
// compiled API, with the fake embedding.

import { addMember, boot, eventually, me, Person, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Compiled, like the app runs: Nest's DI needs the decorator metadata tsc emits.
import { server as application } from '../../dist/server.js';

const ana = new Person('Ana Recall');
const bob = new Person('Bob Recall');
let tenant = '';

beforeAll(async () => {
  await boot(application);
  await ana.signUp();
  await bob.signUp();
  tenant = (await me(ana)).tenantId;
  // Bob works in Ana's business as staff: his own notes and meetings only.
  await addMember(bob, tenant, ['staff']);
});
afterAll(shutdown);

const inAna = (who: Person) => (method: string, path: string, body?: unknown) =>
  who.call(method, path, body, { 'x-tenant-id': tenant });

type Item = { kind: string; type: string; id: string; text: string; about?: object };

const recall = async (who: Person, query: Record<string, string>) =>
  inAna(who)('GET', `/api/memory/recall?${new URLSearchParams(query)}`);

/** Recall until the index has it (the worker embeds new records within a second or two). */
const recalled = (who: Person, q: string, about?: string) =>
  eventually(async () => {
    const res = await recall(who, { q, kinds: 'record', ...(about ? { about } : {}) });
    return (res.body.items as Item[]).length ? (res.body.items as Item[]) : undefined;
  });

describe('notes as memory of their meeting', () => {
  let kitchen = '';

  it('a note is recalled by meaning, with the meeting it belongs to', async () => {
    const meeting = await inAna(ana)('POST', '/api/meetings', {
      title: 'Kitchen review',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      attendees: ['Asha'],
    });
    expect(meeting.status).toBe(201);
    kitchen = meeting.body.value.id;
    const note = await inAna(ana)('POST', '/api/notes', {
      title: 'Kitchen colours',
      body: 'We chose a teal splash-back.',
      meetingId: kitchen,
    });
    expect(note.status).toBe(201);
    const items = await recalled(ana, 'teal splash-back');
    expect(items[0]).toMatchObject({
      kind: 'record',
      type: 'note',
      text: 'Kitchen colours: We chose a teal splash-back.',
      about: { type: 'meeting', id: kitchen },
    });
  });

  it('the assistant recalls it through recall-memory', async () => {
    const res = await ana.chat('what do you remember about the splash-back?');
    expect(res.status).toBe(200);
    expect(res.body.toolCalls).toMatchObject([{ tool: 'recall-memory', outcome: 'done' }]);
    expect(res.body.reply).toContain('teal splash-back');
  });

  it('memory of one meeting stays with it; a meeting the caller cannot read is a 404', async () => {
    const items = await recalled(ana, 'teal splash-back', `meeting:${kitchen}`);
    expect(items.map((i) => i.about)).toEqual(items.map(() => ({ type: 'meeting', id: kitchen })));
    expect((await recall(bob, { q: 'teal', about: `meeting:${kitchen}` })).status).toBe(404);
  });

  it('a member who cannot read the note recalls nothing of it', async () => {
    const res = await recall(bob, { q: 'teal splash-back kitchen colours' });
    expect(res.status).toBe(200);
    expect((res.body.items as Item[]).map((i) => i.text).join('\n')).not.toContain('teal');
    // Another business: nothing either.
    const stranger = new Person('Cy Recall');
    await stranger.signUp();
    const theirs = await stranger.call('GET', '/api/memory/recall?q=teal+splash-back');
    expect(theirs.body.items).toEqual([]);
  });

  it('closing a meeting writes a summary note: the command’s note is memory too', async () => {
    const closed = await inAna(ana)('POST', `/api/meetings/${kitchen}/close`, {
      summary: 'We agreed on oak shelves above the counter.',
    });
    expect(closed.status).toBe(200);
    const items = await recalled(ana, 'oak shelves counter');
    expect(items[0]).toMatchObject({ type: 'note', about: { type: 'meeting', id: kitchen } });
    expect(items[0].text).toContain('oak shelves');
  });
});

describe("the business's memory", () => {
  it('everyone in the business recalls it; the assistant adds to it when asked', async () => {
    const add = await inAna(ana)('POST', '/api/memories', { text: 'The office closes at six' });
    expect(add.status).toBe(201);
    const forBob = await recalled(bob, 'when does the office close');
    expect(forBob.map((i) => i.text)).toContain('The office closes at six');

    const res = await ana.chat('remember that the van is serviced on Fridays');
    expect(res.body.toolCalls).toMatchObject([{ tool: 'create-memory', outcome: 'done' }]);
    const listed = await inAna(bob)('GET', '/api/memories');
    expect(listed.body.items.map((m: { text: string }) => m.text)).toContain(
      'the van is serviced on Fridays',
    );
  });
});
