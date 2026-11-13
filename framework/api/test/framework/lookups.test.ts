// Which calls of a turn only looked something up (V13): a read whose view came before a change
// in the same turn. Pure: the tool outputs as the agent returned them.
import { lookupsIn, wroteIn } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';

const list = { ok: true, result: { items: [] }, present: { kind: 'text', text: 'No tasks.' } };
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
const opened = { ok: true, result: {}, present: { kind: 'open', screen: 'tasks' } };

const of = (...outputs: unknown[]) => [...lookupsIn(outputs)].sort((a, b) => a - b);

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

describe('a lookup', () => {
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
  it("is never a change's own view, a canvas it opened, or a call before a refusal", () => {
    expect(of({ ...done, present: card }, done)).toEqual([]);
    expect(of(parked, done)).toEqual([]);
    expect(of(opened, done)).toEqual([]);
    // A refusal may be a read's: what came before it stays.
    expect(of(list, refused)).toEqual([]);
  });
});
