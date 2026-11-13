// A turn's calls as saved in its thread, and as an agent run reads them back (V13). A call whose
// input the tool refused (Mastra's `{ error: true, validationErrors }`: the tool never ran) is
// saved as refused, so a run reconciled from its saved parts reports it refused, as the turn did.
import { describe, expect, it } from 'vitest';
import { summarizeParts } from '../../dist/features/agents/agents.service.js';
import { compact } from '../../dist/modules/chat/chat.service.js';

const inputRefused = {
  error: true,
  message: 'Tool input validation failed for transition-orders',
  validationErrors: [{ path: ['move'], message: 'Invalid option' }],
};

describe('a call whose input the tool refused', () => {
  it('is saved as refused, with no words for people', () => {
    const saved = compact(inputRefused as never);
    expect(saved?.ok).toBe(false);
    expect(JSON.stringify(saved)).not.toMatch(/validation/i);
  });

  it('reads back refused, as the turn summed it up', () => {
    const part = (output: unknown) => ({
      type: 'tool-transition-orders',
      toolCallId: 'c1',
      state: 'output-available',
      input: {},
      output,
    });
    expect(summarizeParts([part(compact(inputRefused as never))] as never)).toEqual([
      { tool: 'transition-orders', ok: false, outcome: 'refused' },
    ]);
    // A part saved before it was marked: no `ok`, an empty error.
    expect(summarizeParts([part({ error: {} })] as never)).toEqual([
      { tool: 'transition-orders', ok: false, outcome: 'refused' },
    ]);
    // A call that ran still reads done.
    expect(summarizeParts([part(compact({ ok: true, result: {} } as never))] as never)).toEqual([
      { tool: 'transition-orders', ok: true, outcome: 'done' },
    ]);
  });
});
