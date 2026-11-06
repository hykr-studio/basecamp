/**
 * What the orders module teaches the assistant: the scripted model's scripts (MODEL_MODE=fake)
 * and its evals (`basecamp eval --module orders`). A script's verbs must not take another
 * module's eval turns: defineServer checks it at boot.
 */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases } from './evals.js';
import { ordersScripts } from './scripts.js';

export const ordersAgent: AgentModule = {
  rules: [
    'An order is saved whole with save-order: every item at once, prices as decimal strings in the order currency. To change one, send its orderId and every item to keep, with their ids.',
  ],
  scripts: ordersScripts,
  evalCases,
};
