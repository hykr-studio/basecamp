import { MemorySpec } from '@hykr/contracts';
import { defineEntity } from '@hykr/core';
import { memories } from '@hykr/db';
import { anyRole } from './access.js';

/**
 * The business's memory. Every role reaches the business here; the `memory.access` plugin
 * narrows that by capability (`memory.read`, `memory.write`, `memory.manage`), so an
 * application's own roles opt in by holding them.
 */
export const Memory = defineEntity(MemorySpec, {
  table: memories,
  owner: (t) => t.ownerId,
  access: { read: anyRole('tenant'), write: anyRole('tenant') },
  summarize: (action, input, row) => {
    const text = String(input?.text ?? row?.text ?? '');
    const short = text.length > 60 ? `${text.slice(0, 59)}…` : text;
    const verb = { create: 'Remember', update: 'Change the memory', delete: 'Forget' }[action];
    return `${verb} "${short}"`;
  },
});
