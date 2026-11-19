/**
 * What the orders module teaches the assistant: the scripted model's scripts (MODEL_MODE=fake)
 * and its evals (`basecamp eval --module orders`). A script's verbs must not take another
 * module's eval turns: defineServer checks it at boot.
 */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases, voiceEvalCases } from './evals.js';
import { ordersScripts } from './scripts.js';

export const ordersAgent: AgentModule = {
  rules: [
    'An order is saved whole with save-order: every item at once, prices as decimal strings in the order currency. To change one, send its orderId and every item to keep, with their ids.',
    'For how many orders there are or what they add up to (by status, by month), use summarize-orders: never add up a list yourself.',
  ],
  scripts: ordersScripts,
  evalCases,
  voiceEvalCases,
  // The business counts in one currency, and has one order for the lists and totals to find.
  evalSetup: async (api) => {
    await api('PATCH', '/api/settings/sections/money', {
      value: { currency: 'INR', fyStartMonth: 4 },
    });
    await api('POST', '/api/orders/save', {
      title: 'Eval kitchen',
      items: [{ ref: '1', kind: 'line', title: 'Cabinet', quantity: 2, unitPrice: '1500' }],
    });
  },
};
