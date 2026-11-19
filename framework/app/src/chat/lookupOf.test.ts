// The app hides a lookup's view (V13): a read whose view came before a write of the same reply,
// or before the record it found was shown or opened.
import { describe, expect, it } from 'vitest';
import { isLookup, type MessagePart } from './lookupOf';

/** A text part of the reply: it carries no call. */
const said: MessagePart = { type: 'text' };
const call = (toolCallId: string, toolName: string, result: unknown): MessagePart => ({
  type: 'tool-call',
  toolCallId,
  toolName,
  result,
});
const list = {
  ok: true,
  result: { items: [{ id: 'm1' }] },
  present: { kind: 'inline', view: 'task.list' },
};
const parked = {
  ok: true,
  result: { status: 'needs_approval', approval: { id: 'a1', summary: 'Delete Tiles' } },
  present: { kind: 'inline', view: 'approval.card', props: { approvalId: 'a1' } },
};
const refused = { ok: false, status: 409, error: { reason: 'A draft cannot take Approve' } };
const opened = {
  ok: true,
  result: { shown: true },
  present: { kind: 'open', params: { id: 'm1' } },
};
const WRITES = new Set(['delete-task', 'transition-orders']);

describe('a lookup in a reply', () => {
  it('is the list read before the request, never the request', () => {
    const parts = [said, call('c1', 'list-tasks', list), call('c2', 'delete-task', parked), said];
    expect(isLookup(parts, 'c1', WRITES)).toBe(true);
    expect(isLookup(parts, 'c2', WRITES)).toBe(false);
  });
  it('is the list read before a write that was refused, or is still running', () => {
    const refusedMove = [call('c1', 'list-orders', list), call('c2', 'transition-orders', refused)];
    expect(isLookup(refusedMove, 'c1', WRITES)).toBe(true);
    // Streaming: the write is called and has not answered yet; its tool says it writes.
    const running = [call('c1', 'list-tasks', list), call('c2', 'delete-task', undefined)];
    expect(isLookup(running, 'c1', WRITES)).toBe(true);
  });
  it('is the list read before the record it found was opened', () => {
    const parts = [call('c1', 'list-meetings', list), call('c2', 'canvas-open', opened)];
    expect(isLookup(parts, 'c1', WRITES)).toBe(true);
  });
  it('is not a list with nothing after it, nor before a read still running', () => {
    expect(isLookup([call('c1', 'list-tasks', list)], 'c1', WRITES)).toBe(false);
    expect(
      isLookup([call('c1', 'list-tasks', list), call('c2', 'get-task', undefined)], 'c1'),
    ).toBe(false);
    expect(isLookup([call('c1', 'list-tasks', list)], 'missing', WRITES)).toBe(false);
  });
});
