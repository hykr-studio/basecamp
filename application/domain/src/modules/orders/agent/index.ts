/**
 * What the orders module teaches the assistant: its rules, the scripted model's scripts
 * (MODEL_MODE=fake) and its evals (`basecamp eval --module orders`). A script's verbs must not
 * take another module's eval turns: defineServer checks it at boot.
 */
import type { AgentModule } from '@hykr/agents/script';

export const ordersAgent: AgentModule = {
  rules: [],
  scripts: [],
  evalCases: [],
};
