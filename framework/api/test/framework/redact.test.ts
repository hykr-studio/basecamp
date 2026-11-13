// The copy walker of audit redaction (decisions V3): what leaves a copy of an erased record, at
// any depth, and what stays. No database: the walker is a pure function.
import { describe, expect, it } from 'vitest';
import { copyTarget, scrubCopy, scrubInput } from '../../dist/features/privacy/redact.js';

const X = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const t = copyTarget({ type: 'card', ids: [X], fields: ['name', 'phone'] }, [A]);

describe('a copy of an erased record', () => {
  it('loses the fields at the top when it is the record', () => {
    expect(scrubCopy({ id: X, name: 'Cy', phone: '9', amount: 3 }, t, true)).toEqual({
      id: X,
      amount: 3,
    });
    // At the top without an id too: an update's patch is the record's.
    expect(scrubCopy({ name: 'Cy', amount: 3 }, t, true)).toEqual({ amount: 3 });
  });

  it('loses them from every object that is the record, at any depth', () => {
    const reply = { invite: { id: X, name: 'Cy' }, token: 't', rows: [[{ id: X, phone: '9' }]] };
    expect(scrubCopy(reply, t)).toEqual({ invite: { id: X }, token: 't', rows: [[{ id: X }]] });
  });

  it('keeps objects that only reference it, and comes back as it was when nothing changes', () => {
    const todo = { row: { id: OTHER, cardId: X, name: 'Keep me' } };
    expect(scrubCopy(todo, t)).toBe(todo);
    expect(scrubCopy('text', t)).toBe('text');
    expect(scrubCopy(null, t)).toBe(null);
  });
});

describe("a command's input", () => {
  it('loses the fields where it names the record by id or <type>Id', () => {
    expect(scrubInput({ cardId: X, name: 'Cy', amount: 5 }, t)).toEqual({ cardId: X, amount: 5 });
    expect(
      scrubInput(
        {
          lines: [
            { id: X, name: 'Cy' },
            { id: OTHER, name: 'B' },
          ],
        },
        t,
      ),
    ).toEqual({
      lines: [{ id: X }, { id: OTHER, name: 'B' }],
    });
    expect(scrubInput({ otherId: X, name: 'Kept' }, t)).toEqual({ otherId: X, name: 'Kept' });
  });

  it("names it by the set's own keys too", () => {
    const by = copyTarget({ type: 'comment', ids: [X], fields: ['body'], refs: ['replyTo'] });
    expect(scrubInput({ commentId: X, body: 'b' }, by)).toEqual({ commentId: X });
    expect(scrubInput({ replyTo: X, body: 'b' }, by)).toEqual({ replyTo: X });
  });
});

describe('an approval about the record', () => {
  it('loses its summary and the fields in its input, stored or as clients read it', () => {
    const stored = {
      id: A,
      resourceType: 'card',
      resourceId: X,
      summary: 'Rename "Cy"',
      payload: { input: { name: 'Cy', amount: 2 }, level: 'x' },
    };
    expect(scrubCopy({ before: stored }, t)).toEqual({
      before: {
        id: A,
        resourceType: 'card',
        resourceId: X,
        payload: { input: { amount: 2 }, level: 'x' },
      },
    });
    const read = { id: A, resourceType: 'ledger', resourceId: OTHER };
    expect(scrubCopy({ ...read, summary: 's', input: { cardId: X, name: 'Cy' } }, t)).toStrictEqual(
      { ...read, input: { cardId: X } },
    );
  });

  it("leaves a park's row without its summary", () => {
    expect(scrubCopy({ approvalId: A, summary: 'About Cy', level: 'l' }, t)).toEqual({
      approvalId: A,
      level: 'l',
    });
  });
});
