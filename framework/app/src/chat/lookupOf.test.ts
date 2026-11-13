// The app hides a lookup's view (V13): a read whose view came before a write of the same reply.
import { describe, expect, it } from 'vitest';
import { isLookup, type MessagePart } from './lookupOf';

/** A text part of the reply: it carries no call. */
const said: MessagePart = { type: 'text' };
const call = (toolCallId: string, result: unknown): MessagePart => ({
  type: 'tool-call',
  toolCallId,
  result,
});
const list = { ok: true, result: { items: [] }, present: { kind: 'inline', view: 'task.list' } };
const parked = {
  ok: true,
  result: { status: 'needs_approval', approval: { id: 'a1', summary: 'Delete Tiles' } },
  present: { kind: 'inline', view: 'approval.card', props: { approvalId: 'a1' } },
};

describe('a lookup in a reply', () => {
  it('is the list read before the request, never the request', () => {
    const parts = [said, call('c1', list), call('c2', parked), said];
    expect(isLookup(parts, 'c1')).toBe(true);
    expect(isLookup(parts, 'c2')).toBe(false);
  });
  it('is not a list with no write after it, nor one still waiting for the write', () => {
    expect(isLookup([call('c1', list)], 'c1')).toBe(false);
    // Streaming: the write has not answered yet.
    expect(isLookup([call('c1', list), call('c2', undefined)], 'c1')).toBe(false);
    expect(isLookup([call('c1', list)], 'missing')).toBe(false);
  });
});
