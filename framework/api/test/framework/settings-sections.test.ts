// The generic settings writer's pure parts (H2), without booting: the merge patch, unknown keys,
// the base settings' `general`, and the framework's checks that need no database.
import {
  BusinessHours,
  defineSettingsSection,
  editableSection,
  GeneralSettings,
  isEditableSettings,
  MoneySettings,
  mergePatch,
  patchBetween,
  patchSettings,
  SharesSettings,
  storedGeneral,
  unknownSettings,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  businessHoursProblems,
  moneyProblems,
  sharesProblems,
  unreachableBands,
} from '../../dist/features/settings/section-checks.js';

const eur = (minor: number) => ({ minor, currency: 'EUR' });

describe('a merge patch', () => {
  it('merges objects key by key, null removes, anything else replaces', () => {
    const target = { a: 1, b: { c: 2, d: 3 }, list: [1, 2] };
    expect(mergePatch(target, { b: { c: null, e: 4 }, list: [3], f: 'x' })).toEqual({
      a: 1,
      b: { d: 3, e: 4 },
      list: [3],
      f: 'x',
    });
    expect(target).toEqual({ a: 1, b: { c: 2, d: 3 }, list: [1, 2] });
    expect(mergePatch(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
    expect(mergePatch({ a: 1 }, { a: null })).toEqual({});
  });

  it('never touches a prototype', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const out = mergePatch({}, patch) as Record<string, unknown>;
    expect(out).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(unknownSettings(patch, out)).toEqual(['__proto__']);
  });

  it('finds the keys a parse dropped, at any depth, in lists too', () => {
    const schema = z.object({
      a: z.number(),
      nested: z.object({ b: z.number() }),
      rows: z.array(z.object({ c: z.number() })),
      byKey: z.record(z.string(), z.object({ d: z.number() })),
    });
    const patch = {
      a: 1,
      x: 2,
      nested: { b: 1, y: 3 },
      rows: [{ c: 1 }, { c: 2, z: 4 }],
      byKey: { k: { d: 1, w: 5 } },
      gone: null,
    };
    expect(unknownSettings(patch, schema.parse(patch))).toEqual([
      'x',
      'nested.y',
      'rows[1].z',
      'byKey.k.w',
    ]);
  });
});

describe('the patch an editor sends', () => {
  it('is what changed: removed keys as null, nested objects as their own patch', () => {
    const before = { a: 1, b: { c: 2, d: 3 }, list: [1], same: 'x' };
    const after = { b: { c: 2, d: 4 }, list: [1, 2], same: 'x', e: true };
    const patch = patchBetween(before, after);
    expect(patch).toEqual({ a: null, b: { d: 4 }, list: [1, 2], e: true });
    expect(mergePatch(before, patch)).toEqual(after);
    expect(patchBetween(before, before)).toEqual({});
  });
});

describe('patching a section', () => {
  it('keeps what the business set, and answers with the defaults applied', () => {
    const next = patchSettings(SharesSettings, { maxDays: 30 }, { defaultDays: 3 }, 'shares');
    expect(next).toEqual({
      ok: true,
      stored: { maxDays: 30, defaultDays: 3 },
      value: { defaultDays: 3, maxDays: 30, sessionHours: 12 },
    });
  });

  it('names each problem by its path', () => {
    expect(patchSettings(SharesSettings, undefined, { maxDays: 0 }, 'shares')).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/^shares\.maxDays: /)],
    });
    expect(patchSettings(SharesSettings, {}, { forever: true }, 'shares')).toEqual({
      ok: false,
      problems: ['shares.forever: not a setting'],
    });
  });

  it('the base settings: a time zone the runtime knows, times of day, only their four keys', () => {
    const ok = patchSettings(GeneralSettings, {}, { timeZone: 'Europe/Berlin' }, 'general');
    expect(ok).toMatchObject({ ok: true, value: { timeZone: 'Europe/Berlin' } });
    for (const [patch, path] of [
      [{ timeZone: 'Nowhere/Land' }, 'general.timeZone'],
      [{ quietHours: { from: '25:00' } }, 'general.quietHours.from'],
      [{ replyTime: '' }, 'general.replyTime'],
      [{ marketingPerWeek: 1000 }, 'general.marketingPerWeek'],
    ] as const)
      expect(patchSettings(GeneralSettings, {}, patch, 'general')).toMatchObject({
        ok: false,
        problems: [expect.stringContaining(`${path}: `)],
      });
    expect(patchSettings(GeneralSettings, {}, { features: {} }, 'general')).toEqual({
      ok: false,
      problems: ['general.features: not a setting'],
    });
    expect(storedGeneral({ timeZone: 'UTC', features: { a: true }, money: {} })).toEqual({
      timeZone: 'UTC',
    });
  });
});

describe('editable sections', () => {
  it('a section opts in, with settings.manage or its own capability; general is no section', () => {
    expect(editableSection('approvals')?.editable).toEqual({ capability: 'settings.manage' });
    expect(editableSection('credits')).toBeUndefined();
    expect(editableSection('models')).toBeUndefined();
    expect(isEditableSettings('general')).toBe(true);
    expect(isEditableSettings('wording')).toBe(false);
    expect(() =>
      defineSettingsSection('general' as never, z.object({}).default({}) as never),
    ).toThrow(/base setting/);
  });
});

describe("the framework's checks", () => {
  it('bands no amount reaches', () => {
    const at = (i: number) => `b[${i}]`;
    expect(unreachableBands([eur(10), eur(20), undefined], at)).toEqual([]);
    expect(unreachableBands([undefined, eur(10)], at)).toEqual([
      'b[1]: no amount reaches this band (an earlier one takes it)',
    ]);
    expect(unreachableBands([eur(20), eur(20)], at)).toHaveLength(1);
    // Another currency is another ladder.
    expect(unreachableBands([eur(20), { minor: 10, currency: 'USD' }], at)).toEqual([]);
  });

  it('money: a currency the runtime knows, bounds that go up', () => {
    expect(moneyProblems(MoneySettings.parse({ currency: 'EUR' }))).toEqual([]);
    expect(moneyProblems(MoneySettings.parse({ currency: 'QQQ' }))).toEqual([
      'money.currency: "QQQ" is not a currency',
    ]);
    expect(
      moneyProblems(
        MoneySettings.parse({ bands: { x: [eur(10), { minor: 5, currency: 'USD' }, eur(10)] } }),
      ),
    ).toEqual(['money.bands.x[2]: each bound is above the one before it']);
  });

  it('business hours: no overlaps, no repeated holidays', () => {
    const week = {
      mon: [
        { from: '13:00', to: '17:00' },
        { from: '09:00', to: '13:00' },
      ],
    };
    expect(businessHoursProblems(BusinessHours.parse({ week }))).toEqual([]);
    expect(
      businessHoursProblems(
        BusinessHours.parse({
          week: { tue: [...week.mon, { from: '16:00', to: '18:00' }] },
          holidays: ['2026-01-01', '2026-01-01'],
        }),
      ),
    ).toEqual([
      'businessHours.week.tue: open intervals overlap',
      'businessHours.holidays: 2026-01-01 is listed twice',
    ]);
    // A time that is no time of day is the schema's issue, never a thrown error.
    expect(
      BusinessHours.safeParse({ week: { mon: [{ from: '09:00', to: '25:00' }] } }).success,
    ).toBe(false);
  });

  it('share links: the usual lifetime within the longest', () => {
    expect(sharesProblems(SharesSettings.parse({ defaultDays: 30, maxDays: 7 }))).toEqual([
      'shares.defaultDays: at most maxDays (the longest a link may last)',
    ]);
    expect(
      sharesProblems(SharesSettings.parse({ maxDays: 1, defaultDays: 1, sessionHours: 48 })),
    ).toHaveLength(1);
  });
});
