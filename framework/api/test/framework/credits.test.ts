// Credits arithmetic, without a server: CREDITS_CONFIG, the effective plan, prices, the budget
// and limits, overrides and headroom.
import { afterEach, describe, expect, it } from 'vitest';
import {
  assess,
  headroomOf,
  limitRefusal,
  refusalFor,
} from '../../dist/features/credits/budget.js';
import {
  CreditsConfigError,
  creditsFor,
  parseCreditsConfig,
  priceFor,
  resolvePlan,
} from '../../dist/features/credits/config.js';
import { FrameworkMeters, modelInputPrice } from '../../dist/features/credits/meters.js';
import { buyCredits, providerFor } from '../../dist/features/credits/writes.js';

const config = parseCreditsConfig(
  JSON.stringify({
    currency: 'XXX',
    prices: { tool_calls: 10, messages: 4, 'messages.marketing': 9, voice_seconds: 60 },
    defaults: { allowance: 100, alertAt: 75 },
  }),
);

const plan = (settings: object = {}, now = new Date('2030-01-15T00:00:00Z')) =>
  resolvePlan(config, settings, now);

describe('CREDITS_CONFIG', () => {
  it('unset is no currency, no prices and the neutral plan', () => {
    const empty = parseCreditsConfig(undefined);
    expect(empty).toEqual({ prices: {}, markupPercent: 0, defaults: {} });
    expect(resolvePlan(empty, undefined)).toMatchObject({
      enforce: false,
      allowance: 0,
      period: 'month',
      alertAt: 80,
      pauseAt: 100,
      limits: {},
      prices: {},
      pauseMessages: [],
      override: null,
      currency: null,
    });
  });

  it('refuses malformed JSON, unknown fields and a bad currency, listing every problem', () => {
    expect(() => parseCreditsConfig('{')).toThrow(CreditsConfigError);
    try {
      parseCreditsConfig(JSON.stringify({ currency: 'xx', extra: 1, prices: { 'BAD KEY': 1 } }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CreditsConfigError);
      expect((e as CreditsConfigError).problems.length).toBeGreaterThanOrEqual(3);
    }
    expect(() => parseCreditsConfig(JSON.stringify({ defaults: { pauseAt: 0 } }))).toThrow(
      /pauseAt/,
    );
    // Well formed, but no currency: a credit would be a guessed fraction of it.
    expect(() => parseCreditsConfig(JSON.stringify({ currency: 'ABC' }))).toThrow(
      /"ABC" is not a currency/,
    );
    expect(parseCreditsConfig(JSON.stringify({ currency: 'JPY' })).currency).toBe('JPY');
  });

  it('refuses defaults whose alert is not below their pause (V5)', () => {
    for (const defaults of [{ alertAt: 100 }, { pauseAt: 80 }, { alertAt: 95, pauseAt: 90 }])
      expect(() => parseCreditsConfig(JSON.stringify({ defaults }))).toThrow(
        /defaults: alertAt \(\d+\) must be below pauseAt \(\d+\)/,
      );
    expect(
      parseCreditsConfig(JSON.stringify({ defaults: { alertAt: 85, pauseAt: 90 } })).defaults,
    ).toEqual({ alertAt: 85, pauseAt: 90 });
  });
});

describe('the effective plan', () => {
  it('is the business’s, then the deployment’s, then the framework’s; maps merge by key', () => {
    const p = plan({
      enforce: true,
      prices: { tool_calls: 12, voice_seconds: 30 },
      limits: { messages: 5 },
    });
    expect(p).toMatchObject({
      enforce: true,
      allowance: 100,
      alertAt: 75,
      pauseAt: 100,
      limits: { messages: 5 },
      prices: { tool_calls: 12, messages: 4, 'messages.marketing': 9, voice_seconds: 30 },
      currency: 'XXX',
    });
  });

  it('keeps an override only while it holds', () => {
    const until = '2030-01-16T00:00:00Z';
    expect(plan({ override: { mode: 'run', until, reason: 'x' } }).override?.mode).toBe('run');
    expect(
      plan({ override: { mode: 'run', until, reason: 'x' } }, new Date('2030-01-17T00:00:00Z'))
        .override,
    ).toBeNull();
    expect(plan({ override: { mode: 'pause', reason: 'x' } }).override?.mode).toBe('pause');
  });
});

describe('prices', () => {
  it('a variant’s own price wins over its meter’s', () => {
    const prices = plan().prices;
    expect(priceFor(prices, 'messages', 'marketing')).toBe(9);
    expect(priceFor(prices, 'messages', 'utility')).toBe(4);
    expect(priceFor(prices, 'messages')).toBe(4);
    expect(priceFor(prices, 'tokens')).toBeUndefined();
  });

  it('credits round up, per the meter’s pricing unit', () => {
    expect(creditsFor(60, 30, 60)).toBe(30);
    expect(creditsFor(60, 31, 60)).toBe(31);
    expect(creditsFor(1000, 1, 1_000_000)).toBe(1);
    expect(creditsFor(0.1, 30)).toBe(3);
    expect(creditsFor(0, 1000)).toBe(0);
  });
});

const counters = (
  cost: number,
  extra: { meter: string; quantity: number; cost: number }[] = [],
) => [{ meter: 'tool_calls', quantity: cost / 10, cost }, ...extra];

describe('the budget', () => {
  it('is not there without credits on, or without a currency', () => {
    expect(assess(plan(), counters(1000), null).budget).toBeNull();
    const noCurrency = resolvePlan(parseCreditsConfig('{}'), { enforce: true, allowance: 5 });
    expect(assess(noCurrency, counters(10), null).budget).toBeNull();
  });

  it('spends the allowance, then the wallet; alerts and pauses at the thresholds', () => {
    const on = plan({ enforce: true });
    const at = (spent: number, balance: number | null) => assess(on, counters(spent), balance);
    expect(at(70, null).budget).toMatchObject({
      remaining: 30,
      total: 100,
      usedPercent: 70,
      alert: false,
      pause: false,
    });
    expect(at(75, null).budget).toMatchObject({ usedPercent: 75, alert: true, pause: false });
    expect(at(100, null).budget).toMatchObject({ remaining: 0, usedPercent: 100, pause: true });
    // 150 spent, 50 of it from a wallet that held 200: 150 left of 300.
    expect(at(150, 150).budget).toMatchObject({ remaining: 150, total: 300, usedPercent: 50 });
    expect(at(150, 150).levels).toEqual([]);
    expect(at(100, null).levels.map((l) => `${l.cap}/${l.level}`)).toEqual([
      'credits/alert',
      'credits/pause',
    ]);
  });

  it('with nothing to spend, a business on credits is paused at once', () => {
    const empty = plan({ enforce: true, allowance: 0 });
    const a = assess(empty, [], null);
    expect(a.budget).toMatchObject({ total: 0, usedPercent: 100, pause: true });
    expect(refusalFor(a, FrameworkMeters.tokens)?.rule).toBe('credits_exhausted');
  });

  it('pauses past 100% when the plan allows an overdraft', () => {
    const over = plan({ enforce: true, pauseAt: 110 });
    expect(assess(over, counters(100), 0).budget?.pause).toBe(false);
    expect(assess(over, counters(110), -10).budget?.pause).toBe(true);
  });
});

describe('what a pause refuses', () => {
  const paused = assess(plan({ enforce: true, pauseMessages: ['marketing'] }), counters(100), null);

  it('turns, voice and the message variants the plan names; never other messages', () => {
    expect(refusalFor(paused, FrameworkMeters.tokens)?.rule).toBe('credits_exhausted');
    expect(refusalFor(paused, FrameworkMeters.voiceSeconds)?.cap).toBe('credits');
    expect(refusalFor(paused, FrameworkMeters.messages, 'marketing')?.rule).toBe(
      'credits_exhausted',
    );
    expect(refusalFor(paused, FrameworkMeters.messages, 'utility')).toBeNull();
    expect(refusalFor(paused, FrameworkMeters.messages, null)).toBeNull();
  });

  it('a limit stops only its meter', () => {
    const a = assess(
      plan({ enforce: true, allowance: 1000, limits: { tool_calls: 2 } }),
      [{ meter: 'tool_calls', quantity: 2, cost: 20 }],
      null,
    );
    expect(refusalFor(a, FrameworkMeters.toolCalls)).toMatchObject({
      rule: 'usage_limit_reached',
      cap: 'tool_calls',
    });
    expect(refusalFor(a, FrameworkMeters.tokens)).toBeNull();
    expect(a.levels.map((l) => `${l.cap}/${l.level}`)).toEqual([
      'tool_calls/alert',
      'tool_calls/pause',
    ]);
  });

  it('a messages limit reports a refusal only when the plan pauses some kind of message', () => {
    const reached = (pauseMessages: string[]) =>
      assess(
        plan({ enforce: true, allowance: 1000, limits: { messages: 2 }, pauseMessages }),
        [{ meter: 'messages', quantity: 2, cost: 8 }],
        null,
      );
    // Nothing is paused when no kind is: the screen must not say messages are refused.
    expect(limitRefusal(reached([]), FrameworkMeters.messages)).toBeNull();
    expect(refusalFor(reached([]), FrameworkMeters.messages, 'utility')).toBeNull();
    // Marketing is paused: the limit refuses it, and the meter says so; a code still goes.
    const some = reached(['marketing']);
    expect(limitRefusal(some, FrameworkMeters.messages)).toMatchObject({
      rule: 'usage_limit_reached',
      cap: 'messages',
    });
    expect(refusalFor(some, FrameworkMeters.messages, 'marketing')?.rule).toBe(
      'usage_limit_reached',
    );
    expect(refusalFor(some, FrameworkMeters.messages, 'authentication')).toBeNull();
  });

  it('a messages limit that stops nothing raises no level: no notice says it pauses', () => {
    const levels = (pauseMessages: string[]) =>
      assess(
        plan({ enforce: true, allowance: 1000, limits: { messages: 2 }, pauseMessages }),
        [{ meter: 'messages', quantity: 2, cost: 8 }],
        null,
      ).levels.map((l) => `${l.cap}/${l.level}`);
    expect(levels([])).toEqual([]);
    expect(levels(['marketing'])).toEqual(['messages/alert', 'messages/pause']);
  });

  it('the override wins: run lets everything through, pause stops it', () => {
    const run = assess(
      plan({ enforce: true, override: { mode: 'run', reason: 'support' } }),
      counters(100),
      null,
    );
    expect(refusalFor(run, FrameworkMeters.tokens)).toBeNull();
    const stop = assess(plan({ override: { mode: 'pause', reason: 'unpaid' } }), [], null);
    expect(refusalFor(stop, FrameworkMeters.tokens)).toMatchObject({
      rule: 'credits_suspended',
      reason: expect.stringContaining('unpaid'),
    });
    // Even a pause never stops the messages that always go.
    expect(refusalFor(stop, FrameworkMeters.messages, 'utility')).toBeNull();
  });
});

describe('embedding tokens', () => {
  const embeddings = FrameworkMeters.embeddingTokens;

  it('pause with the budget, the operator and their own limit; a turn’s limits leave them', () => {
    const paused = assess(plan({ enforce: true }), counters(100), null);
    expect(refusalFor(paused, embeddings, 'gw/embed')?.rule).toBe('credits_exhausted');
    const stop = assess(plan({ override: { mode: 'pause', reason: 'unpaid' } }), [], null);
    expect(refusalFor(stop, embeddings)?.rule).toBe('credits_suspended');
    const limited = assess(
      plan({ enforce: true, allowance: 1000, limits: { embedding_tokens: 50 } }),
      [{ meter: 'embedding_tokens', quantity: 50, cost: 0 }],
      null,
    );
    expect(refusalFor(limited, embeddings)).toMatchObject({
      rule: 'usage_limit_reached',
      cap: 'embedding_tokens',
    });
    expect(refusalFor(limited, FrameworkMeters.tokens)).toBeNull();
    const turns = assess(
      plan({ enforce: true, allowance: 1000, limits: { tokens: 10, tool_calls: 1 } }),
      [
        { meter: 'tokens', quantity: 10, cost: 0 },
        { meter: 'tool_calls', quantity: 1, cost: 10 },
      ],
      null,
    );
    expect(refusalFor(turns, embeddings)).toBeNull();
  });

  describe('unpriced, the model’s own input price plus the markup', () => {
    const saved = process.env.MODEL_PROVIDERS;
    afterEach(() => {
      if (saved === undefined) delete process.env.MODEL_PROVIDERS;
      else process.env.MODEL_PROVIDERS = saved;
    });

    it('in the credits currency only; an unknown or unpriced model costs nothing', () => {
      process.env.MODEL_PROVIDERS = JSON.stringify([
        {
          id: 'gw',
          baseUrl: 'http://gw.example.test/v1',
          apiKey: 'k',
          models: [
            { id: 'embed', kind: 'embedding', price: { currency: 'XXX', inputPerMillion: 50 } },
            { id: 'other', kind: 'embedding', price: { currency: 'USD', inputPerMillion: 50 } },
            { id: 'free', kind: 'embedding' },
          ],
        },
      ]);
      const marked = { ...plan(), markupPercent: 20 };
      expect(embeddings.fallbackPrice?.('gw/embed', marked)).toBe(60);
      expect(embeddings.fallbackPrice?.('gw/embed', plan())).toBe(50);
      expect(embeddings.fallbackPrice?.('gw/other', marked)).toBeUndefined();
      expect(embeddings.fallbackPrice?.('gw/free', marked)).toBeUndefined();
      expect(embeddings.fallbackPrice?.('gw/missing', marked)).toBeUndefined();
      expect(embeddings.fallbackPrice?.(null, marked)).toBeUndefined();
      // No credits currency: nothing is in it.
      const noCurrency = resolvePlan(parseCreditsConfig('{}'), undefined);
      expect(modelInputPrice('gw/embed', noCurrency)).toBeUndefined();
      // 1,000 tokens at 60 per million: one credit, rounded up.
      expect(creditsFor(60, 1000, embeddings.per)).toBe(1);
      // A registry that does not parse prices nothing (it is reported where it is loaded).
      process.env.MODEL_PROVIDERS = '{';
      expect(modelInputPrice('gw/embed', marked)).toBeUndefined();
    });
  });
});

describe('headroom', () => {
  it('is what is left before the pause, by the limit and by the credits at the price', () => {
    const p = plan({ enforce: true, limits: { voice_seconds: 600 } });
    // 40 of 100 credits spent, voice at 60 a minute: 60 credits are 60 seconds.
    const a = assess(p, [{ meter: 'voice_seconds', quantity: 40, cost: 40 }], null);
    expect(headroomOf(a, FrameworkMeters.voiceSeconds, 60)).toBe(60);
    // Without a price only the limit counts.
    expect(headroomOf(a, FrameworkMeters.voiceSeconds, undefined)).toBe(560);
    expect(headroomOf(assess(plan(), [], null), FrameworkMeters.voiceSeconds, 60)).toBeUndefined();
  });
});

describe('purchase providers', () => {
  it('none registered is a 503', () => {
    try {
      providerFor();
      expect.unreachable();
    } catch (e) {
      const http = e as { getStatus(): number; getResponse(): { error: string } };
      expect(http.getStatus()).toBe(503);
      expect(http.getResponse().error).toBe('purchases_unavailable');
    }
  });

  it('who may buy is decided first: with no provider set up, the assistant is refused (V5)', async () => {
    const op = buyCredits();
    const assistant = {
      actor: { kind: 'agent', id: 'assistant' },
      tenantId: 't1',
      capabilities: [],
    } as unknown as Parameters<typeof op.authorize>[0];
    const loaded = await op.load?.({} as never, assistant, { amount: 100 });
    expect(op.authorize(assistant, loaded as never, { amount: 100 })).toMatchObject({
      decision: 'deny',
      rule: 'people_only',
    });
  });
});
