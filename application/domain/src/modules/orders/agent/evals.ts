import type { EvalCase } from '@hykr/agents/script';

/** The orders module's eval conversation (`basecamp eval --module orders`), in order. */
export const evalCases: EvalCase[] = [
  {
    why: 'an order is saved whole, and the assistant waits for approval',
    input: 'order Kitchen: 2 Cabinet at 1500, 1 Sink at 800 +18%',
    expect: { must: ['save-order'], mustNot: ['cancel-order'], replyIncludes: 'approv' },
  },
  {
    why: 'lists orders without changing any',
    input: 'list orders',
    expect: { must: ['list-orders'], mustNot: ['save-order', 'cancel-order'] },
  },
];
