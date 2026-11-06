// The sample as four modules: closing a meeting still writes the note and to-dos of the modules
// it builds on, and a module's evals pass on their own (a fresh user, that module's setup).

import { runEval } from '@hykr/api';
import { boot, Person, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Compiled, like the app runs: Nest's DI needs the decorator metadata tsc emits.
import { server as application } from '../../dist/server.js';

const ana = new Person('Ana Modules');
const bob = new Person('Bob Modules');

beforeAll(async () => {
  await boot(application);
  await ana.signUp();
  await bob.signUp();
});
afterAll(shutdown);

describe('the sample modules', () => {
  it('are todos, notes, meetings and orders, in dependency order', () => {
    expect(application.catalog.modules.map((m) => [m.name, m.dependsOn])).toEqual([
      ['todos', []],
      ['notes', []],
      ['meetings', ['todos', 'notes']],
      ['orders', []],
    ]);
    expect(application.catalog.moduleOf('order.save')).toBe('orders');
    expect(application.catalog.moduleOf('meeting.close')).toBe('meetings');
  });

  it('a close writes through the notes and to-dos modules, in one transaction', async () => {
    const meeting = await ana.call('POST', '/api/meetings', {
      title: 'Module sync',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const id = meeting.body.value.id;
    expect((await bob.call('POST', `/api/meetings/${id}/close`, { summary: 'x' })).status).toBe(
      404,
    );
    const closed = await ana.call('POST', `/api/meetings/${id}/close`, {
      summary: 'We agreed.',
      actionItems: [{ title: 'Send the plan' }],
    });
    expect(closed.body.status).toBe('done');
    const todos = await ana.call('GET', `/api/todos?meetingId=${id}`);
    expect(todos.body.items.map((t: { title: string }) => t.title)).toEqual(['Send the plan']);
    const notes = await ana.call('GET', `/api/notes?meetingId=${id}`);
    expect(notes.body.items).toHaveLength(1);
  });
});

// One module's evals, as `basecamp eval --module meetings` runs them: a fresh user and only its
// own setup and cases. (Every module's, and the voice and WhatsApp suites, are `pnpm eval`'s:
// each turn takes seconds, too slow to run them all here.)
describe('a module evaluated on its own', () => {
  it('meetings: its cases pass after its own setup, with no to-dos made first', async () => {
    expect(await runEval(application, 'assistant', { module: 'meetings' })).toBe(true);
  }, 120_000);

  it('orders: a whole order is saved and waits for approval; the list reads them', async () => {
    expect(await runEval(application, 'assistant', { module: 'orders' })).toBe(true);
  }, 120_000);
});
