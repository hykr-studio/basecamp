// What the credits say to people, without a server (V13). One use may overshoot what is left
// and take the wallet below zero: the budget's used share then reads at most 100%, in the
// reason and the status, while the pause still follows the real numbers.
import { describe, expect, it } from 'vitest';
import { assess, headroomOf, refusalFor } from '../../dist/features/credits/budget.js';
import { parseCreditsConfig, resolvePlan } from '../../dist/features/credits/config.js';
import { FrameworkMeters } from '../../dist/features/credits/meters.js';

const config = parseCreditsConfig(JSON.stringify({ currency: 'XXX', prices: { tool_calls: 10 } }));
const plan = (settings: object) => resolvePlan(config, { enforce: true, ...settings });
/** 170 credits spent: 17 tool calls at 10. */
const spent170 = [{ meter: 'tool_calls', quantity: 17, cost: 170 }];

describe("the budget's share past what was left", () => {
  it('reads at most 100% once one use takes the wallet below zero', () => {
    // Allowance 100, a top-up of 50, then one action of 70 past it: the wallet is at -20.
    const a = assess(plan({ allowance: 100 }), spent170, -20);
    expect(a.budget).toMatchObject({ spent: 170, balance: -20, remaining: -20, pause: true });
    expect(a.budget?.usedPercent).toBe(100);
    const reasons = (['en', 'hi', 'te'] as const).map(
      (lang) => refusalFor(a, FrameworkMeters.toolCalls, undefined, lang)?.reason,
    );
    expect(reasons).toEqual([
      'This business has used 100% of its credits this period',
      'इस व्यवसाय ने इस अवधि में अपने क्रेडिट का 100% उपयोग कर लिया है',
      'ఈ వ్యాపారం ఈ వ్యవధిలో తన క్రెడిట్‌లలో 100% వాడింది',
    ]);
    // The pause level's row carries what people are told, too.
    expect(a.levels.filter((l) => l.cap === 'credits').map((l) => l.usedPercent)).toEqual([
      100, 100,
    ]);
  });

  it('a plan that pauses past 100 still pauses on the real numbers', () => {
    // Pause at 150%: 170 of 110 (the wallet at -60) is 154.5%, so it pauses, reading 100%.
    const over = assess(plan({ allowance: 100, pauseAt: 150 }), spent170, -60);
    expect(over.budget).toMatchObject({ total: 110, pause: true, usedPercent: 100 });
    expect(refusalFor(over, FrameworkMeters.toolCalls)?.rule).toBe('credits_exhausted');
    expect(headroomOf(over, FrameworkMeters.toolCalls, 10)).toBe(0);
    // 170 of 130 (the wallet at -40) is 130.8%: not paused yet, and 25 credits still go.
    const under = assess(plan({ allowance: 100, pauseAt: 150 }), spent170, -40);
    expect(under.budget).toMatchObject({ total: 130, pause: false, usedPercent: 100 });
    expect(refusalFor(under, FrameworkMeters.toolCalls)).toBeNull();
    expect(headroomOf(under, FrameworkMeters.toolCalls, 10)).toBe(2);
  });

  it('within what was left, it reads as it is', () => {
    const a = assess(plan({ allowance: 200 }), spent170, 0);
    expect(a.budget?.usedPercent).toBe(85);
  });
});
