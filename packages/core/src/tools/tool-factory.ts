import { type ApiClient, ApiError } from '@app/api-client';
import {
  type CommandSpec,
  type EntitySpec,
  listInputObject,
  type Present,
  type Principal,
  type WriteResult,
} from '@app/contracts';
import type { Registry } from '@app/ui-registry';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { resolvePresent } from './present.js';

/**
 * Agent tools from the same specs the API serves. Each tool calls the HTTP API through
 * the typed client with the agent's headers, so the agent still passes PrincipalGuard,
 * the throttler and every rule, and packages/agents never touches the database.
 */

export type ToolContext = {
  requestContext?: { get(key: string): unknown };
  tracingContext?: { currentSpan?: { traceId?: string } };
  loggerVNext?: { info(m: string, d?: object): void; warn(m: string, d?: object): void };
};
export type ClientFor = (ctx: ToolContext | undefined) => ApiClient;

/**
 * What every tool factory needs: how to call the API for a run, and the registry of views
 * its results may be shown with. Passed in, so the framework never imports a domain.
 */
export type ToolKit = { clientFor: ClientFor; registry: Registry };

/** What a successful result shows: a registered view, a screen, a page (see present.ts). */
type PresentOf<T> = (result: T) => Present | undefined;

/**
 * Refusals become data the model can explain, not exceptions that end the run. A result
 * that can be shown carries its present intent, resolved for the turn's surfaces.
 */
export async function safely<T>(
  tool: string,
  ctx: ToolContext | undefined,
  kit: ToolKit,
  fn: () => Promise<T>,
  presentOf?: PresentOf<T>,
) {
  try {
    const result = await fn();
    ctx?.loggerVNext?.info(`${tool} ok`, { tool });
    const intent = presentOf?.(result);
    if (!intent) return { ok: true as const, result };
    const resolved = await resolvePresent(intent, ctx, kit);
    if ('error' in resolved) {
      // The framework built this intent, so a failure is a declaration bug, not the model's.
      ctx?.loggerVNext?.warn(`${tool}: present dropped`, { tool, error: resolved.error });
      return { ok: true as const, result };
    }
    return { ok: true as const, result, ...resolved };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { reason?: string; message?: unknown } | null;
      ctx?.loggerVNext?.warn(`${tool} refused by the API (${e.status})`, {
        tool,
        status: e.status,
        reason: body?.reason ?? body?.message,
      });
      return { ok: false as const, status: e.status, error: e.body };
    }
    throw e;
  }
}

/** How the model will see one principal: an agent acting for someone. */
const agentPrincipal: Principal = {
  actor: { kind: 'agent', id: 'agent', role: 'agent' },
  actingFor: { userId: 'user' },
  scopes: [],
};

function needsApproval(spec: EntitySpec, action: 'create' | 'update' | 'delete') {
  const rule = spec.approval[action];
  return rule === 'always' || (typeof rule === 'function' && rule(agentPrincipal));
}

const APPROVAL =
  ' Returns { status: "needs_approval", approval } instead of doing it: tell the user what is waiting and that they approve it in the app.';

/** A parked write shows the person what is waiting, with Approve and Reject. */
function parked(result: unknown): Present | undefined {
  const r = result as WriteResult<unknown>;
  return r?.status === 'needs_approval'
    ? {
        kind: 'inline',
        view: 'approval.card',
        props: { approvalId: r.approval.id, summary: r.approval.summary },
      }
    : undefined;
}

/** One line in the tool description, so the model says a line about it instead of the list. */
function shownAs(registry: Registry, view: string | undefined) {
  return view && registry.getViewDef(view)
    ? ` The result is shown to the user as a ${view}; do not repeat its items in your reply, say one line about it.`
    : '';
}

export function entityTools(spec: EntitySpec, kit: ToolKit) {
  const { clientFor } = kit;
  const { name, plural, label, list } = spec;
  const max = list.toolPageSize ?? 20;
  const examples = Object.entries(list.examples ?? {})
    .map(([field, example]) => `"${field}": ${example}`)
    .join(', ');
  const ops = Object.entries(list.filterable)
    .map(([field, type]) => `${field} (${type})`)
    .join(', ');
  const exposed = (action: keyof EntitySpec['expose']) => spec.expose[action] === 'all';
  const api = (ctx: ToolContext | undefined) => clientFor(ctx).entity(spec);

  const tools: Record<string, ReturnType<typeof createTool>> = {};
  if (exposed('list')) {
    tools[`list-${plural}`] = createTool({
      id: `list-${plural}`,
      description: `${spec.description}${shownAs(kit.registry, spec.views?.list)} Lists ${label}s with their ids. Filter on ${ops}: a value means equals, or use an object with eq, ne, in, lt, lte, gt, gte (dates, numbers) or contains (text). Examples: ${examples}.${list.search?.length ? ` "q" searches ${list.search.join(' and ')}.` : ''} "sort": "-field" for descending (sortable: ${list.sortable.join(', ')}). At most ${max} per call; pass nextCursor back as "cursor" for more.`,
      inputSchema: listInputObject(spec, { maxLimit: max }),
      execute: async (input, ctx) => {
        // The view re-runs the same query on the client, with the person's session.
        const { cursor: _cursor, limit: _limit, ...query } = input as Record<string, unknown>;
        return safely(
          `list-${plural}`,
          ctx,
          kit,
          () => api(ctx).list({ limit: max, ...(input as object) }),
          () => (spec.views?.list ? { kind: 'inline', view: spec.views.list, query } : undefined),
        );
      },
    });
  }
  if (exposed('get')) {
    tools[`get-${name}`] = createTool({
      id: `get-${name}`,
      description: `Get one ${label} by id.${shownAs(kit.registry, spec.views?.item)}`,
      inputSchema: z.object({ id: z.string().describe(`The ${label} id`) }),
      execute: async ({ id }, ctx) =>
        safely(
          `get-${name}`,
          ctx,
          kit,
          () => api(ctx).get(id),
          () =>
            spec.views?.item ? { kind: 'inline', view: spec.views.item, props: { id } } : undefined,
        ),
    });
  }
  if (exposed('create')) {
    tools[`create-${name}`] = createTool({
      id: `create-${name}`,
      description: `Create a ${label}.${needsApproval(spec, 'create') ? APPROVAL : ''}`,
      inputSchema: spec.schemas.create,
      execute: async (input, ctx) =>
        safely(`create-${name}`, ctx, kit, () => api(ctx).create(input as never), parked),
    });
  }
  if (exposed('update')) {
    tools[`update-${name}`] = createTool({
      id: `update-${name}`,
      description: `Change a ${label}: send its id and only the fields to change. Use an id from list-${plural}.${needsApproval(spec, 'update') ? APPROVAL : ''}`,
      inputSchema: z.object({
        id: z.string().describe(`The ${label} id`),
        ...spec.schemas.update.shape,
      }),
      execute: async ({ id, ...patch }, ctx) =>
        safely(
          `update-${name}`,
          ctx,
          kit,
          () => api(ctx).update(id as string, patch as never),
          parked,
        ),
    });
  }
  if (exposed('delete')) {
    tools[`delete-${name}`] = createTool({
      id: `delete-${name}`,
      description: `Delete a ${label} by id from list-${plural}.${needsApproval(spec, 'delete') ? ` The user must approve it before it is removed.${APPROVAL}` : ''}`,
      inputSchema: z.object({ id: z.string().describe(`The ${label} id`) }),
      execute: async ({ id }, ctx) =>
        safely(`delete-${name}`, ctx, kit, () => api(ctx).remove(id), parked),
    });
  }
  return tools;
}

export function commandTools(specs: readonly CommandSpec[], kit: ToolKit) {
  const { clientFor } = kit;
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const spec of specs) {
    if (!spec.tool || spec.expose !== 'all') continue;
    const id = spec.tool;
    tools[id] = createTool({
      id,
      description: `${spec.description}${spec.approvalNote ? ` ${spec.approvalNote}${APPROVAL}` : ''}`,
      inputSchema: spec.input,
      execute: async (input, ctx) =>
        safely(
          id,
          ctx,
          kit,
          () => clientFor(ctx).command(spec, input as never),
          (result) =>
            parked(result) ??
            (spec.view
              ? {
                  kind: 'inline',
                  view: spec.view.name,
                  props: { id: spec.view.id(input as never) },
                }
              : undefined),
        ),
    });
  }
  return tools;
}
