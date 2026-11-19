// Approval levels as the write path applies them: the application's level rules on the input and
// the row, then the level's policy with the business's settings. Pure: no database. The levels
// and thresholds are this test's own (the framework declares none).
import {
  approvalLevels,
  approvalThreshold,
  bandApprover,
  checkApprovalLevels,
  defineApprovalLevel,
  overThreshold,
  type Principal,
  parseTenantSettings,
  rankOf,
  type TenantConfig,
} from '@hykr/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { allow, atLevel, deny, needsApproval } from '../authorize.js';
import { applyLevels, defineLevelRule, effectiveLevel, levelRules, matchesOp } from './levels.js';

const label = { en: 'x', hi: 'x', te: 'x' };
const person: Principal = {
  actor: { kind: 'user', id: 'ana' },
  subject: { kind: 'user', userId: 'ana' },
  tenantId: 't1',
  roles: ['owner'],
  scopes: [],
};
const assistant: Principal = { ...person, actor: { kind: 'agent', id: 'assistant' } };

const settings = (approvals: unknown = {}): TenantConfig => parseTenantSettings({ approvals });
const eur = (minor: number) => ({ minor, currency: 'EUR' });

beforeAll(() => {
  approvalLevels.register(
    defineApprovalLevel({ name: 'look', rank: 0, label }),
    defineApprovalLevel({ name: 'kept', rank: 1, label, policy: { parks: false, undoMs: 10_000 } }),
    defineApprovalLevel({
      name: 'outside',
      rank: 2,
      label,
      policy: { parks: (p) => p.actor.kind !== 'user', tenantMayLoosen: true },
    }),
    defineApprovalLevel({ name: 'final', rank: 3, label, policy: { expiresInMs: 120_000 } }),
  );
  levelRules.register(
    defineLevelRule({
      name: 'fixture.payments',
      on: ['payment.*'],
      decide: ({ input, settings: s }) => {
        const amount = eur(Number(input?.amountMinor ?? 0));
        return overThreshold(s, 'payments.limit', amount)
          ? atLevel('final', 'payment_over_limit', 'Above the limit', { amount })
          : atLevel('kept', 'payment_small', 'Within the limit', { amount });
      },
    }),
  );
});

describe('levels', () => {
  it('rank orders them; an unknown level ranks above all, no level below all', () => {
    expect(rankOf('kept')).toBe(1);
    expect(rankOf('nobody_declared')).toBe(Number.POSITIVE_INFINITY);
    expect(rankOf(undefined)).toBe(-1);
    expect(() => checkApprovalLevels()).not.toThrow();
  });

  it('defineApprovalLevel checks its name, rank, undo window and expiry', () => {
    expect(() => defineApprovalLevel({ name: 'Bad', rank: 1, label })).toThrow(/lower case/);
    expect(() => defineApprovalLevel({ name: 'x', rank: 1.5, label })).toThrow(/rank/);
    expect(() => defineApprovalLevel({ name: 'x', rank: 100, label })).toThrow(/rank/);
    expect(() =>
      defineApprovalLevel({ name: 'x', rank: 1, label, policy: { undoMs: -1 } }),
    ).toThrow(/undoMs/);
    expect(() =>
      defineApprovalLevel({ name: 'x', rank: 1, label, policy: { expiresInMs: 1000 } }),
    ).toThrow(/expiresInMs/);
  });

  it('a level rule matches operation names, prefixes and *', () => {
    expect(matchesOp('payment.*', 'payment.create')).toBe(true);
    expect(matchesOp('payment.*', 'payments.create')).toBe(false);
    expect(matchesOp('notify.send', 'notify.send')).toBe(true);
    expect(matchesOp('*', 'anything.at.all')).toBe(true);
    expect(() => defineLevelRule({ name: 'x', on: [], decide: () => null })).toThrow(/at least/);
    expect(() => defineLevelRule({ name: 'x', on: ['Bad Op'], decide: () => null })).toThrow();
  });
});

describe('a level policy in one business', () => {
  it('neutral defaults: rank 0 runs, any higher level parks; an unknown level parks', () => {
    expect(effectiveLevel('look', person, settings()).parks).toBe(false);
    expect(effectiveLevel('final', person, settings()).parks).toBe(true);
    expect(effectiveLevel('nobody_declared', person, settings())).toMatchObject({
      parks: true,
      undoMs: 0,
    });
  });

  it('a policy can park for some requesters only, and give an undo window and an expiry', () => {
    expect(effectiveLevel('outside', person, settings()).parks).toBe(false);
    expect(effectiveLevel('outside', assistant, settings()).parks).toBe(true);
    expect(effectiveLevel('kept', person, settings())).toMatchObject({
      parks: false,
      undoMs: 10_000,
    });
    expect(effectiveLevel('final', person, settings()).expiresInMs).toBe(120_000);
  });

  it('a business tightens any level, loosens only one that allows it, and sets the windows', () => {
    const s = settings({
      levels: {
        look: { parks: true },
        outside: { parks: false },
        final: { parks: false, expiresInMs: 600_000 },
        kept: { undoMs: 30_000 },
      },
    });
    expect(effectiveLevel('look', person, s).parks).toBe(true);
    expect(effectiveLevel('outside', assistant, s).parks).toBe(false);
    // 'final' does not let a business loosen it: it still parks.
    expect(effectiveLevel('final', person, s)).toMatchObject({ parks: true, expiresInMs: 600_000 });
    expect(effectiveLevel('kept', person, s).undoMs).toBe(30_000);
  });
});

describe('applyLevels: level rules on the payload, then the policy', () => {
  const op = (name: string) => ({ name, kind: 'entity' as const, resourceType: 'payment' });
  const run = (decision = allow('scoped_access'), input: unknown = {}, s = settings()) =>
    applyLevels({
      decision,
      p: person,
      op: op('payment.create'),
      input,
      loaded: null,
      settings: async () => s,
    });

  it('above the business threshold it parks at the level, with the amount', async () => {
    const s = settings({ thresholds: { 'payments.limit': eur(100_00) } });
    expect(await run(allow('scoped_access'), { amountMinor: 250_00 }, s)).toEqual({
      decision: 'needs_approval',
      rule: 'payment_over_limit',
      reason: 'Above the limit',
      level: 'final',
      amount: eur(250_00),
    });
  });

  it('within it, it runs with the level undo window; a business can make it wait', async () => {
    const s = settings({ thresholds: { 'payments.limit': eur(100_00) } });
    expect(await run(allow('scoped_access'), { amountMinor: 50_00 }, s)).toEqual({
      decision: 'allow',
      rule: 'payment_small',
      reason: 'Within the limit',
      level: 'kept',
      amount: eur(50_00),
      undoMs: 10_000,
    });
    const strict = settings({
      thresholds: { 'payments.limit': eur(100_00) },
      levels: { kept: { parks: true } },
    });
    expect(await run(allow('scoped_access'), { amountMinor: 50_00 }, strict)).toMatchObject({
      decision: 'needs_approval',
      rule: 'payment_small',
      level: 'kept',
    });
  });

  it('no threshold set (or one in another currency) counts as over: fails closed', async () => {
    expect((await run(allow('scoped_access'), { amountMinor: 1 })).level).toBe('final');
    const usd = settings({ thresholds: { 'payments.limit': { minor: 100_00, currency: 'USD' } } });
    expect((await run(allow('scoped_access'), { amountMinor: 1 }, usd)).level).toBe('final');
  });

  it('never loosens a refusal or a park', async () => {
    const s = settings({ thresholds: { 'payments.limit': eur(100_00) } });
    expect((await run(deny('no', 'No'), { amountMinor: 1 }, s)).decision).toBe('deny');
    const parked = await run(needsApproval('wait', 'Waits'), { amountMinor: 50_00 }, s);
    expect(parked).toMatchObject({ decision: 'needs_approval', rule: 'wait', level: 'kept' });
  });

  it('an operation no rule matches is left alone, and reads no settings', async () => {
    let read = false;
    const out = await applyLevels({
      decision: allow('ok'),
      p: person,
      op: op('other.create'),
      input: {},
      loaded: null,
      settings: async () => {
        read = true;
        return settings();
      },
    });
    expect(out).toEqual(allow('ok'));
    expect(read).toBe(false);
  });

  it('a level that runs gives its undo window, the longer of it and the decision', async () => {
    const out = await applyLevels({
      decision: atLevel('outside', 'send', 'Sends', { undoMs: 5_000 }),
      p: person,
      op: op('other.send'),
      input: {},
      loaded: null,
      settings: async () => settings(),
    });
    expect(out).toMatchObject({ decision: 'allow', level: 'outside', undoMs: 5_000 });
  });
});

describe('approval settings', () => {
  const s = settings({
    thresholds: { 'payments.limit': eur(100_00) },
    bands: {
      money: [
        { upTo: eur(100_00), approver: { capability: 'approvals.decide' } },
        { upTo: eur(1_000_00), approver: { userId: 'u-lead' } },
        { approver: { userId: 'u-head' } },
      ],
    },
  });

  it('thresholds: over is strictly above, in the same currency', () => {
    expect(approvalThreshold(s, 'payments.limit')).toEqual(eur(100_00));
    expect(overThreshold(s, 'payments.limit', eur(100_00))).toBe(false);
    expect(overThreshold(s, 'payments.limit', eur(100_01))).toBe(true);
  });

  it('bands: the first band whose upTo covers the amount, or the open one', () => {
    expect(bandApprover(s, 'money', eur(50_00))).toEqual({ capability: 'approvals.decide' });
    expect(bandApprover(s, 'money', eur(500_00))).toEqual({ userId: 'u-lead' });
    expect(bandApprover(s, 'money', eur(5_000_00))).toEqual({ userId: 'u-head' });
    // Another currency skips the bands that name one; no amount, no band.
    expect(bandApprover(s, 'money', { minor: 1, currency: 'USD' })).toEqual({ userId: 'u-head' });
    expect(bandApprover(s, 'money', undefined)).toBeUndefined();
    expect(bandApprover(s, 'other', eur(1))).toBeUndefined();
  });

  it('a new business has none, and bad values do not parse', () => {
    expect(parseTenantSettings({}).approvals).toEqual({ levels: {}, thresholds: {}, bands: {} });
    expect(() =>
      parseTenantSettings({ approvals: { thresholds: { x: { minor: 1.5, currency: 'EUR' } } } }),
    ).toThrow();
    expect(() =>
      parseTenantSettings({ approvals: { bands: { x: [{ approver: { roles: ['owner'] } }] } } }),
    ).toThrow();
  });
});
