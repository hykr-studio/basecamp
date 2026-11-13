import {
  type EntitySpec,
  type Present,
  statesOf,
  transitionToolId,
  type WriteResult,
} from '@hykr/contracts';
import { safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { runtime } from '../../runtime.js';

/** Where each move goes, for the model: "submit (draft → submitted; may wait for approval)". */
function moves(spec: EntitySpec): string {
  const trait = statesOf(spec);
  if (!trait) return '';
  return trait.transitions
    .filter((t) => (t.expose ?? 'all') === 'all')
    .map((t) => {
      const from = typeof t.from === 'string' ? t.from : t.from.join(' or ');
      const notes = [
        (t.approval !== undefined && t.approval !== 'never') || t.level !== undefined
          ? 'may wait for approval'
          : '',
        t.requires?.length ? `needs ${t.requires.join(', ')}` : '',
      ].filter(Boolean);
      return `${t.name} (${from} → ${t.to}${notes.length ? `; ${notes.join('; ')}` : ''})`;
    })
    .join(', ');
}

/** A parked move shows the approval; a done one, the record. */
function shown(spec: EntitySpec, id: string) {
  return (result: unknown): Present | undefined => {
    const r = result as WriteResult<unknown>;
    if (r?.status === 'needs_approval')
      return {
        kind: 'inline',
        view: 'approval.card',
        props: {
          approvalId: r.approval.id,
          summary: r.approval.summary,
          ...(r.approval.canDecide === false ? { canDecide: false } : {}),
        },
      };
    return spec.views?.item ? { kind: 'inline', view: spec.views.item, props: { id } } : undefined;
  };
}

/**
 * One tool per entity with states, `transition-<plural>`: move a record by a transition the
 * assistant may ask for (`expose: 'all'`). It calls POST /api/transitions as the agent, acting
 * for the person, so every check, approval and audit applies.
 */
export const transitionTools: ToolContribution = {
  name: 'states',
  tools: (kit) => {
    const out: Record<string, ReturnType<typeof createTool>> = {};
    for (const spec of Object.values(runtime().catalog.entities) as EntitySpec[]) {
      const trait = statesOf(spec);
      const open = trait?.transitions.filter((t) => (t.expose ?? 'all') === 'all') ?? [];
      if (!trait || !open.length) continue;
      const update = spec.schemas.update.shape as Record<string, z.ZodType>;
      const fields = Object.fromEntries(
        [...new Set(open.flatMap((t) => t.fields ?? []))]
          .filter((f) => update[f])
          .map((f) => [f, (update[f] as z.ZodType).optional()]),
      );
      const id = transitionToolId(spec);
      out[id] = createTool({
        id,
        description: `Move a ${spec.label} to another ${trait.field} by one of its transitions. Moves: ${moves(spec)}. Send the ${spec.label}'s id (from list-${spec.plural}) and the transition's name. A move that waits returns { status: "needs_approval", approval }: tell the user what is waiting.`,
        inputSchema: z.object({
          id: z.string().describe(`The ${spec.label} id`),
          transition: z.enum(open.map((t) => t.name) as [string, ...string[]]),
          ...fields,
        }),
        execute: async (input, ctx) => {
          const { id: recordId, transition, ...rest } = input as Record<string, unknown>;
          // The tool takes every move's fields; a move gets only its own (the route refuses
          // any other).
          const own = new Set(open.find((t) => t.name === transition)?.fields ?? []);
          const taken = Object.fromEntries(Object.entries(rest).filter(([k]) => own.has(k)));
          return safely(
            id,
            ctx,
            kit,
            () =>
              kit
                .clientFor(ctx)
                .transition(spec, String(recordId), String(transition), taken as never),
            shown(spec, String(recordId)),
          );
        },
      });
    }
    return out;
  },
};
