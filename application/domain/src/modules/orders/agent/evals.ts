import type { EvalCase } from '@hykr/agents/script';

/** The orders module's eval conversation (`basecamp eval --module orders`), in order. */
export const evalCases: EvalCase[] = [
  {
    why: 'an order is saved whole, and the assistant waits for approval',
    input: 'order Kitchen: 2 Cabinet at 1500, 1 Sink at 800 +18%',
    expect: {
      must: ['list-orders', 'save-order'],
      mustNot: ['cancel-order'],
      replyIncludes: 'approv',
    },
  },
  {
    why: "doesn't invent an id for an order that isn't there",
    input: 'cancel order ORD/1999-00/9999',
    expect: { must: ['list-orders'], mustNot: ['cancel-order'] },
  },
  {
    why: "makes no PDF of an order that isn't there",
    input: 'pdf of order ORD/1999-00/9999',
    expect: { must: ['list-orders'], mustNot: ['render-document', 'send-document'] },
  },
  {
    why: 'lists orders without changing any',
    input: 'list orders',
    expect: { must: ['list-orders'], mustNot: ['save-order', 'cancel-order'] },
  },
  {
    why: 'totals orders by status with the summary tool, never by adding up a list',
    input: 'orders by status',
    expect: { must: ['summarize-orders'], mustNot: ['list-orders', 'save-order'] },
  },
  {
    why: 'totals orders by month',
    input: 'order totals by month',
    expect: { must: ['summarize-orders'], mustNot: ['save-order', 'cancel-order'] },
  },
];
