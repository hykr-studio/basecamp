// Which calls of a turn only looked something up (V13): a read whose view came before a change
// in the same turn, or before a call that showed one of its rows. Pure: each call's tool and its
// output as the agent got it, and the catalog's write tools.
import { createCatalog, lookupsIn, type TurnCall, writeToolIds, wroteIn } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { tasksSpec, visitsSpec } from '../fixture/dist/contracts.js';
import { PrivateTicketSpec, ticketsSpec } from '../fixture/dist/features/states/index.js';

const list = {
  ok: true,
  result: { items: [{ id: 't1', title: 'Buy milk' }] },
  present: { kind: 'text', text: '• Buy milk', choices: [{ id: 't1', title: 'Buy milk' }] },
};
const emptyList = { ok: true, result: { items: [] }, present: { kind: 'text', text: 'No tasks.' } };
const inlineList = {
  ok: true,
  result: { items: [{ id: 't1' }, { id: 't2' }] },
  present: { kind: 'inline', view: 'task.list', query: {} },
};
const card = { kind: 'inline', view: 'task.card', props: { id: 't1' } };
const record = (status: string) => ({
  ok: true,
  result: { id: 'o1', title: 'Hall', status },
  present: card,
});
const done = { ok: true, result: { status: 'done', value: { id: 't1' } } };
const parked = {
  ok: true,
  result: { status: 'needs_approval', approval: { id: 'a1', summary: 'Delete Tiles' } },
  present: { kind: 'inline', view: 'approval.card', props: { approvalId: 'a1' } },
};
const resumed = { ok: true, result: { status: 'approved', approval: { id: 'a1' } } };
const refused = { ok: false, status: 403, error: { error: 'forbidden', reason: 'No' } };
const notFound = { ok: false, status: 404, error: { error: 'not_found' } };
/** Mastra's answer when the tool's schema refused the input: the tool never ran. */
const invalid = { error: true, message: 'Tool input validation failed', validationErrors: [] };
const opened = (id: string) => ({
  ok: true,
  result: { shown: true },
  present: { kind: 'open', screen: 'task.view', params: { id } },
});
/** A record read and shown: on a screen by its view, in words by the record it read. */
const shownInline = (id: string) => ({
  ok: true,
  result: { id, title: 'Buy milk' },
  present: { kind: 'inline', view: 'task.card', props: { id } },
});
const shownInWords = (id: string) => ({
  ok: true,
  result: { id, title: 'Buy milk' },
  present: { kind: 'text', text: 'Buy milk' },
});

const WRITES = new Set(['delete-task', 'transition-tasks']);
/** The lookups, with no tool known: only a write's result tells it. */
const of = (...outputs: unknown[]) =>
  [...lookupsIn(outputs.map((output) => ({ output })))].sort((a, b) => a - b);
/** The lookups of calls by their tools, `WRITES` the catalog's write tools. */
const ofCalls = (...xs: [string, unknown][]) => {
  const calls: TurnCall[] = xs.map(([tool, output]) => ({ tool, output }));
  return [...lookupsIn(calls, WRITES)].sort((a, b) => a - b);
};

describe('a write, by its result', () => {
  it('is done with its value, waits for an approval, or says how its request was decided', () => {
    expect([done, parked, resumed].map(wroteIn)).toEqual([true, true, true]);
  });
  it("is never a read's record, whatever its own status says", () => {
    expect(
      [record('done'), record('approved'), record('needs_approval'), list, refused].map(wroteIn),
    ).toEqual([false, false, false, false, false]);
  });
});

describe("the catalog's write tools", () => {
  it('are the creates, updates, deletes, commands and moves the assistant may call', () => {
    const tasks = writeToolIds(createCatalog(tasksSpec, visitsSpec));
    for (const write of ['create-task', 'update-task', 'delete-task', 'reschedule-visit'])
      expect(tasks.has(write)).toBe(true);
    for (const read of ['list-tasks', 'get-task', 'summarize-tasks', 'canvas-open'])
      expect(tasks.has(read)).toBe(false);
    const tickets = writeToolIds(createCatalog(ticketsSpec));
    expect(tickets.has('transition-tickets')).toBe(true);
    // What only people may do gives the assistant no tool, so no write tool.
    expect(tickets.has(`transition-${PrivateTicketSpec.plural}`)).toBe(false);
    expect(tickets.has(`delete-${PrivateTicketSpec.name}`)).toBe(false);
  });
});

describe('a lookup before a change', () => {
  it('is a read whose view came before a change in the same turn', () => {
    expect(of(list, done)).toEqual([0]);
    expect(of(list, parked)).toEqual([0]);
    expect(of(record('approved'), resumed)).toEqual([0]);
    expect(of(list, record('draft'), done)).toEqual([0, 1]);
  });
  it('is not a read with no change after it: that is the answer', () => {
    expect(of(list)).toEqual([]);
    expect(of(list, list)).toEqual([]);
    expect(of(done, list)).toEqual([]);
    expect(of(list, done, list)).toEqual([0]);
  });
  it("is never a change's own view, or a canvas it opened", () => {
    expect(of({ ...done, present: card }, done)).toEqual([]);
    expect(of(parked, done)).toEqual([]);
    expect(of(opened('t1'), done)).toEqual([]);
  });
  it('is a read before a write refused by the API or by its input: a write by its tool', () => {
    expect(ofCalls(['list-tasks', list], ['transition-tasks', refused])).toEqual([0]);
    expect(ofCalls(['list-tasks', emptyList], ['delete-task', notFound])).toEqual([0]);
    expect(ofCalls(['list-tasks', list], ['transition-tasks', invalid])).toEqual([0]);
    // Its tool unknown, a refusal says nothing of a write.
    expect(of(list, refused)).toEqual([]);
  });
  it('is not a read before a refused read', () => {
    expect(ofCalls(['list-tasks', list], ['get-task', notFound])).toEqual([]);
    expect(ofCalls(['list-tasks', list], ['get-task', invalid])).toEqual([]);
  });
});

describe('a lookup before what it found', () => {
  it('is a list whose row a later call showed, in words or on a screen, or opened', () => {
    expect(ofCalls(['list-tasks', list], ['get-task', shownInWords('t1')])).toEqual([0]);
    expect(ofCalls(['list-tasks', inlineList], ['get-task', shownInline('t2')])).toEqual([0]);
    expect(ofCalls(['list-tasks', inlineList], ['canvas-open', opened('t1')])).toEqual([0]);
  });
  it('is not a list whose rows nothing after it showed', () => {
    expect(ofCalls(['list-tasks', list], ['get-task', shownInWords('t9')])).toEqual([]);
    expect(ofCalls(['list-tasks', inlineList], ['canvas-open', opened('t9')])).toEqual([]);
    // Several lists, each the answer ("today"): none showed a row of another.
    expect(ofCalls(['list-tasks', list], ['list-tasks', inlineList])).toEqual([]);
    // A row read with no view: the list is still what the turn showed.
    const bare = { ok: true, result: { id: 't1' } };
    expect(ofCalls(['list-tasks', list], ['get-task', bare])).toEqual([]);
    // The record shown is the answer, and so is a list after it.
    expect(ofCalls(['get-task', shownInWords('t1')], ['list-tasks', list])).toEqual([]);
  });
});
