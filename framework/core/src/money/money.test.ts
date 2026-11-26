import {
  addMoney,
  allocateMinor,
  applyTax,
  buildTree,
  CurrencyMismatch,
  countNodes,
  defineNumberSeries,
  defineTaxFunction,
  exceeds,
  flattenTree,
  formatNumber,
  fromMinor,
  KnownCurrencyCode,
  type Money,
  MoneySettings,
  moneyBand,
  mulDiv,
  numberPeriod,
  resolveMoneyInput,
  sumMoney,
  TreeError,
  toMinor,
  treeDepth,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';

const eur = (minor: number): Money => ({ minor, currency: 'EUR' });

describe('rounding', () => {
  it('rounds halves as asked, on both signs', () => {
    const at = (minor: number, mode: Parameters<typeof mulDiv>[3]) => mulDiv(minor, 1, 2, mode);
    expect([5, 7, -5, -7].map((m) => at(m, 'half-up'))).toEqual([3, 4, -3, -4]);
    expect([5, 7, -5, -7].map((m) => at(m, 'half-even'))).toEqual([2, 4, -2, -4]);
    expect([5, 7, -5, -7].map((m) => at(m, 'down'))).toEqual([2, 3, -2, -3]);
    expect([5, 7, -5, -7].map((m) => at(m, 'up'))).toEqual([3, 4, -3, -4]);
    expect([5, 7, -5, -7].map((m) => at(m, 'floor'))).toEqual([2, 3, -3, -4]);
    expect([5, 7, -5, -7].map((m) => at(m, 'ceil'))).toEqual([3, 4, -2, -3]);
    expect(mulDiv(10, 1, 3)).toBe(3);
    expect(mulDiv(10, 2, 3)).toBe(7);
  });

  it('is exact past 2^53 in the product', () => {
    // 9e15 × 18% would lose units as a float.
    expect(mulDiv(9_000_000_000_000_001, 18, 100)).toBe(1_620_000_000_000_000);
    expect(() => mulDiv(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(RangeError);
    expect(() => mulDiv(1.5, 1, 1)).toThrow(RangeError);
    expect(() => mulDiv(1, 1, 0)).toThrow(RangeError);
  });

  it('allocates so the parts add up to the whole', () => {
    expect(allocateMinor(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateMinor(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocateMinor(5, [0, 3, 1])).toEqual([0, 4, 1]);
    const parts = allocateMinor(999_999, [3, 7, 11, 13]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(999_999);
    expect(() => allocateMinor(1, [0, 0])).toThrow(RangeError);
  });

  it('adds only one currency', () => {
    expect(addMoney(eur(150), eur(-50))).toEqual(eur(100));
    expect(sumMoney([], 'EUR')).toEqual(eur(0));
    expect(() => sumMoney([eur(1), { minor: 1, currency: 'JPY' }], 'EUR')).toThrow(
      CurrencyMismatch,
    );
  });
});

describe('decimals and minor units', () => {
  it("reads a decimal with the currency's exponent", () => {
    expect(toMinor('1234.5', 'EUR')).toBe(123450);
    expect(toMinor('-0.05', 'EUR')).toBe(-5);
    expect(toMinor('1235', 'JPY')).toBe(1235);
    expect(toMinor('10.00', 'JPY')).toBe(10);
    expect(toMinor('1.234', 'BHD')).toBe(1234);
    expect(() => toMinor('1.234', 'EUR')).toThrow(/2 decimals/);
    expect(() => toMinor('10.5', 'JPY')).toThrow(/0 decimals/);
    expect(() => toMinor('1e3', 'EUR')).toThrow();
  });

  it('writes minor units back as a decimal', () => {
    expect(fromMinor(123450, 'EUR')).toBe('1234.50');
    expect(fromMinor(-5, 'EUR')).toBe('-0.05');
    expect(fromMinor(1234, 'BHD')).toBe('1.234');
    expect(fromMinor(7, 'JPY')).toBe('7');
  });

  it("resolves a write's amount in the record's currency", () => {
    expect(resolveMoneyInput('12.5', 'EUR')).toEqual(eur(1250));
    expect(resolveMoneyInput({ minor: 99 }, 'EUR')).toEqual(eur(99));
    expect(resolveMoneyInput({ minor: 99, currency: 'EUR' }, 'EUR')).toEqual(eur(99));
    expect(() => resolveMoneyInput({ minor: 99, currency: 'JPY' }, 'EUR')).toThrow(
      CurrencyMismatch,
    );
    expect(() => resolveMoneyInput(12.5 as never, 'EUR')).toThrow();
  });

  it('refuses a currency that does not exist, in either shape, and still reads one', () => {
    expect(() => toMinor('1.00', 'ABC')).toThrow(RangeError);
    expect(() => toMinor('1.00', 'ABC')).toThrow('"ABC" is not a currency');
    expect(() => resolveMoneyInput('1', 'ABC')).toThrow(RangeError);
    // Minor units never looked up an exponent: the code is checked all the same.
    expect(() => resolveMoneyInput({ minor: 1 }, 'ABC')).toThrow('"ABC" is not a currency');
    expect(() => resolveMoneyInput({ minor: 1, currency: 'ABC' }, 'ABC')).toThrow(RangeError);
    expect(resolveMoneyInput({ minor: 1 }, 'XXX')).toEqual({ minor: 1, currency: 'XXX' });
    // The read side: a row stored with a made-up code still turns into a decimal.
    expect(fromMinor(100, 'ABC')).toBe('1.00');
  });

  it('KnownCurrencyCode: the format first, then a currency the runtime knows', () => {
    expect(KnownCurrencyCode.parse('JPY')).toBe('JPY');
    expect(KnownCurrencyCode.parse('XXX')).toBe('XXX');
    const unknown = KnownCurrencyCode.safeParse('ABC');
    expect(unknown.error?.issues.map((i) => i.message)).toEqual(['"ABC" is not a currency']);
    const lower = KnownCurrencyCode.safeParse('eur');
    expect(lower.error?.issues).toHaveLength(1);
    expect(lower.error?.issues[0].message).toMatch(/upper case/);
  });
});

describe('money settings', () => {
  it('defaults to nothing chosen', () => {
    expect(MoneySettings.parse(undefined)).toEqual({ fyStartMonth: 1, amounts: {}, bands: {} });
  });

  it('a limit fails closed: none, or another currency, counts as exceeded', () => {
    expect(exceeds(eur(100), eur(100))).toBe(false);
    expect(exceeds(eur(101), eur(100))).toBe(true);
    expect(exceeds(eur(1), undefined)).toBe(true);
    expect(exceeds(eur(1), { minor: 100, currency: 'JPY' })).toBe(true);
  });

  it('finds the band an amount falls in', () => {
    const bounds = [eur(1000), eur(10_000)];
    expect(moneyBand(eur(500), bounds)).toBe(0);
    expect(moneyBand(eur(1000), bounds)).toBe(0);
    expect(moneyBand(eur(5000), bounds)).toBe(1);
    expect(moneyBand(eur(50_000), bounds)).toBe(2);
    expect(moneyBand({ minor: 1, currency: 'JPY' }, bounds)).toBe(2);
  });
});

describe('tax lines', () => {
  type Line = { amount: Money; rateBp: number };
  const perRate = defineTaxFunction<Line>({
    name: 'test.per-rate',
    compute: (lines, { currency }) => {
      const rates = [...new Set(lines.map((l) => l.rateBp))];
      return rates.map((rateBp) => {
        const basis = sumMoney(
          lines.filter((l) => l.rateBp === rateBp).map((l) => l.amount),
          currency,
        );
        return {
          code: `rate.${rateBp}`,
          basis,
          rateBp,
          amount: { minor: mulDiv(basis.minor, rateBp, 10_000), currency },
        };
      });
    },
  });

  it("adds up the application's lines", () => {
    const totals = applyTax(
      perRate,
      [
        { amount: eur(1000), rateBp: 1000 },
        { amount: eur(333), rateBp: 1000 },
        { amount: eur(500), rateBp: 500 },
      ],
      { currency: 'EUR' },
    );
    expect(totals.subtotal).toEqual(eur(1833));
    expect(totals.taxLines.map((l) => [l.code, l.amount.minor])).toEqual([
      ['rate.1000', 133],
      ['rate.500', 25],
    ]);
    expect(totals.taxTotal).toEqual(eur(158));
    expect(totals.total).toEqual(eur(1991));
  });

  it('does not add included lines, and refuses bad ones', () => {
    const inside = defineTaxFunction({
      name: 'test.inside',
      compute: (_l, { currency }) => [
        {
          code: 'in',
          basis: { minor: 100, currency },
          amount: { minor: 9, currency },
          included: true,
        },
      ],
    });
    expect(applyTax(inside, [{ amount: eur(100) }], { currency: 'EUR' }).total).toEqual(eur(100));
    const twice = defineTaxFunction({
      name: 'test.twice',
      compute: (_l, { currency }) => [
        { code: 'a', basis: { minor: 1, currency }, amount: { minor: 1, currency } },
        { code: 'a', basis: { minor: 1, currency }, amount: { minor: 1, currency } },
      ],
    });
    expect(() => applyTax(twice, [], { currency: 'EUR' })).toThrow(/twice/);
    const elsewhere = defineTaxFunction({
      name: 'test.elsewhere',
      compute: () => [{ code: 'a', basis: eur(1), amount: { minor: 1, currency: 'JPY' } }],
    });
    expect(() => applyTax(elsewhere, [], { currency: 'EUR' })).toThrow(CurrencyMismatch);
    const fraction = defineTaxFunction({
      name: 'test.fraction',
      compute: () => [{ code: 'a', basis: eur(1), amount: { minor: 0.5, currency: 'EUR' } }],
    });
    expect(() => applyTax(fraction, [], { currency: 'EUR' })).toThrow(/bad line/);
  });
});

describe('number series', () => {
  const calendar = { timeZone: 'UTC', fyStartMonth: 1 };
  const aprilEast = { timeZone: 'Asia/Tokyo', fyStartMonth: 4 };

  it('checks the format and the reset', () => {
    expect(() => defineNumberSeries({ name: 'x', format: 'X-{n}', reset: 'none' })).toThrow(
      /unknown token/,
    );
    expect(() => defineNumberSeries({ name: 'x', format: 'X-{seq}-{seq}', reset: 'none' })).toThrow(
      /exactly once/,
    );
    expect(() => defineNumberSeries({ name: 'x', format: 'X-{yyyy}', reset: 'none' })).toThrow(
      /exactly once/,
    );
    expect(() => defineNumberSeries({ name: 'x', format: 'X-{seq}', reset: 'yearly' })).toThrow(
      /each year/,
    );
    expect(() =>
      defineNumberSeries({ name: 'x', format: 'X/{yyyy}/{seq}', reset: 'fiscal' }),
    ).toThrow(/financial year/);
    expect(() => defineNumberSeries({ name: 'x', format: 'X}{seq}', reset: 'none' })).toThrow(
      /brace/,
    );
    expect(() => defineNumberSeries({ name: 'Bad', format: '{seq}', reset: 'none' })).toThrow();
  });

  it('formats every token', () => {
    const s = defineNumberSeries({
      name: 'test.all',
      format: '{yyyy}{yy}-{mm}/{fy}/{fyStart}{fyStart:yy}/{fyEnd}{fyEnd:yy}/{seq:5}',
      reset: 'fiscal',
    });
    const at = new Date('2027-02-10T12:00:00Z');
    expect(formatNumber(s, 42, at, aprilEast)).toBe('202727-02/2026-27/202626/202727/00042');
    expect(formatNumber(s, 42, at, calendar)).toBe('202727-02/2027/202727/202727/00042');
    expect(
      formatNumber(
        defineNumberSeries({ name: 'p', format: 'P{seq:3}', reset: 'none' }),
        1234,
        at,
        calendar,
      ),
    ).toBe('P1234');
  });

  it("starts a fiscal year in the business's time zone", () => {
    const s = defineNumberSeries({ name: 'test.fy', format: 'D/{fy}/{seq}', reset: 'fiscal' });
    // 31 March 15:30 UTC is already 1 April in Tokyo.
    const edge = new Date('2026-03-31T15:30:00Z');
    expect(numberPeriod(s, edge, aprilEast)).toBe('FY2026');
    expect(numberPeriod(s, edge, { ...aprilEast, timeZone: 'UTC' })).toBe('FY2025');
    expect(formatNumber(s, 1, edge, aprilEast)).toBe('D/2026-27/1');
    const yearly = defineNumberSeries({ name: 'test.y', format: 'Y{yy}-{seq}', reset: 'yearly' });
    expect(numberPeriod(yearly, edge, aprilEast)).toBe('Y2026');
    expect(
      numberPeriod(
        defineNumberSeries({ name: 'n', format: '{seq}', reset: 'none' }),
        edge,
        calendar,
      ),
    ).toBe('-');
  });
});

describe('trees', () => {
  const rows = [
    { id: 'b', up: 'a', pos: 1 },
    { id: 'a', up: null, pos: 0 },
    { id: 'c', up: 'a', pos: 0 },
    { id: 'd', up: 'c', pos: 0 },
    { id: 'e', up: null, pos: 1 },
  ];

  it('builds a tree in order, from rows or flat input', () => {
    const tree = buildTree(rows, { key: 'id', parent: 'up', order: 'pos' });
    expect(tree.map((n) => n.id)).toEqual(['a', 'e']);
    expect(tree[0].children.map((n) => n.id)).toEqual(['c', 'b']);
    expect(countNodes(tree)).toBe(5);
    expect(treeDepth(tree)).toBe(3);
    expect(flattenTree(tree).map((x) => `${x.node.id}${x.depth}`)).toEqual([
      'a1',
      'c2',
      'd3',
      'b2',
      'e1',
    ]);
  });

  it('refuses an unknown parent, a repeated key and a cycle', () => {
    expect(() => buildTree([{ id: 'a', up: 'z' }], { key: 'id', parent: 'up' })).toThrow(TreeError);
    expect(() => buildTree([{ id: 'a' }, { id: 'a' }], { key: 'id', parent: 'up' })).toThrow(
      /twice/,
    );
    expect(() =>
      buildTree(
        [
          { id: 'a', up: 'b' },
          { id: 'b', up: 'a' },
        ],
        { key: 'id', parent: 'up' },
      ),
    ).toThrow(/cycle/);
  });
});
