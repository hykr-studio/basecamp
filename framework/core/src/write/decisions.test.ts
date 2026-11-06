// Combining decisions (entity rules and plugins, then write hooks): the stricter one wins and
// what is at stake adds up. Pure: no database.
import { describe, expect, it } from 'vitest';
import { allow, deny, needsApproval } from '../authorize.js';
import { strongerDecision } from './decisions.js';

describe('strongerDecision', () => {
  it('deny beats needs_approval beats allow, whatever the order', () => {
    const ok = allow('ok');
    const wait = needsApproval('wait', 'Waits');
    const no = deny('no', 'No');
    expect(strongerDecision(ok, wait)?.decision).toBe('needs_approval');
    expect(strongerDecision(wait, ok)?.decision).toBe('needs_approval');
    expect(strongerDecision(wait, no)?.rule).toBe('no');
    expect(strongerDecision(no, ok)?.rule).toBe('no');
  });

  it('null is no opinion', () => {
    expect(strongerDecision(null, null)).toBeNull();
    expect(strongerDecision(null, allow('ok'))?.rule).toBe('ok');
    expect(strongerDecision(deny('no', 'No'), undefined)?.rule).toBe('no');
  });

  it('on a tie the first keeps its rule and reason', () => {
    const first = needsApproval('plugin_review', 'Marked for review', { tier: 2 });
    const second = needsApproval('chore_update_needs_approval', 'Updates need your approval');
    expect(strongerDecision(first, second)).toEqual({
      decision: 'needs_approval',
      rule: 'plugin_review',
      reason: 'Marked for review',
      tier: 2,
    });
  });

  it('the highest tier and the longest undo window survive; an allow never loosens', () => {
    const undo = allow('undoable', 'Undoable', { tier: 1, undoMs: 30_000 });
    const park = needsApproval('money', 'Money waits', {
      tier: 3,
      amount: 500_00,
      approver: { roles: ['owner'] },
    });
    expect(strongerDecision(undo, park)).toEqual({
      decision: 'needs_approval',
      rule: 'money',
      reason: 'Money waits',
      tier: 3,
      undoMs: 30_000,
      amount: 500_00,
      approver: { roles: ['owner'] },
    });
    // Two allows: the window is the longer one.
    expect(strongerDecision(undo, allow('ok', 'ok', { undoMs: 60_000 }))).toMatchObject({
      decision: 'allow',
      rule: 'undoable',
      tier: 1,
      undoMs: 60_000,
    });
  });

  it('a loser of another kind gives no amount or approver: they describe a different decision', () => {
    const allowed = allow('ok', 'ok', { amount: 10, approver: { userId: 'x' } });
    const parked = needsApproval('wait', 'Waits');
    const out = strongerDecision(allowed, parked);
    expect(out).toEqual({ decision: 'needs_approval', rule: 'wait', reason: 'Waits' });
  });
});
