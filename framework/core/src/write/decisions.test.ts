// Combining decisions (entity rules and plugins, then write hooks, then level rules): the
// stricter one wins and what is at stake adds up. Pure: no database. The levels are this test's
// own (the framework declares none).
import { approvalLevels, defineApprovalLevel } from '@hykr/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { allow, atLevel, deny, needsApproval } from '../authorize.js';
import { strongerDecision } from './decisions.js';

const label = { en: 'x', hi: 'x', te: 'x' };
beforeAll(() => {
  approvalLevels.register(
    defineApprovalLevel({ name: 'low', rank: 1, label }),
    defineApprovalLevel({ name: 'mid', rank: 2, label }),
    defineApprovalLevel({ name: 'high', rank: 3, label }),
  );
});

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
    const first = needsApproval('plugin_review', 'Marked for review', { level: 'mid' });
    const second = needsApproval('chore_update_needs_approval', 'Updates need your approval');
    expect(strongerDecision(first, second)).toEqual({
      decision: 'needs_approval',
      rule: 'plugin_review',
      reason: 'Marked for review',
      level: 'mid',
    });
  });

  it('the higher-ranked level and the longest undo window survive; an allow never loosens', () => {
    const undo = allow('undoable', 'Undoable', { level: 'low', undoMs: 30_000 });
    const park = needsApproval('money', 'Money waits', {
      level: 'high',
      amount: { minor: 500_00, currency: 'EUR' },
      approver: { by: { capability: 'approvals.decide' } },
    });
    expect(strongerDecision(undo, park)).toEqual({
      decision: 'needs_approval',
      rule: 'money',
      reason: 'Money waits',
      level: 'high',
      undoMs: 30_000,
      amount: { minor: 500_00, currency: 'EUR' },
      approver: { by: { capability: 'approvals.decide' } },
    });
    // Two allows: the window is the longer one.
    expect(strongerDecision(undo, allow('ok', 'ok', { undoMs: 60_000 }))).toMatchObject({
      decision: 'allow',
      rule: 'undoable',
      level: 'low',
      undoMs: 60_000,
    });
  });

  it('between two of a kind, the higher level says why; ranks, not names, compare', () => {
    const plain = allow('scoped_access', 'Works on rows they reach');
    const levelled = atLevel('mid', 'payment_over_limit', 'Above the limit');
    expect(strongerDecision(plain, levelled)).toEqual({
      decision: 'allow',
      rule: 'payment_over_limit',
      reason: 'Above the limit',
      level: 'mid',
    });
    // 'high' sorts before 'low' by name, but ranks above it.
    expect(strongerDecision(atLevel('high', 'h'), atLevel('low', 'l'))?.level).toBe('high');
    expect(strongerDecision(atLevel('low', 'l'), atLevel('high', 'h'))).toMatchObject({
      rule: 'h',
      level: 'high',
    });
  });

  it('a level nobody declared ranks above every declared one (fail closed)', () => {
    expect(strongerDecision(atLevel('high', 'h'), atLevel('typo', 't'))?.level).toBe('typo');
  });

  it('a loser of another kind gives no amount or approver: they describe a different decision', () => {
    const allowed = allow('ok', 'ok', {
      amount: { minor: 10, currency: 'EUR' },
      approver: { by: { userId: 'x' } },
    });
    const parked = needsApproval('wait', 'Waits');
    const out = strongerDecision(allowed, parked);
    expect(out).toEqual({ decision: 'needs_approval', rule: 'wait', reason: 'Waits' });
  });
});
