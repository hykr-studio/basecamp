import { type ApiClient, ApiError } from '@hykr/api-client';
import {
  type CommandSpec,
  type EntitySpec,
  listInputObject,
  type Present,
  type Principal,
  parksFor,
  type WriteResult,
} from '@hykr/contracts';
import type { Registry } from '@hykr/ui-registry';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  decisionOutcome,
  isParkedCall,
  type ParkedCall,
  parkedApproval,
  runContextOf,
} from './durable.js';
import { resolvePresent } from './present.js';

/**
 * Agent tools from the same specs the API serves. Each tool calls the HTTP API through
 * the typed client with the agent's headers, so the agent still passes PrincipalGuard,
 * the throttler and every rule, and @hykr/agents never touches the database.
 */

export type ToolContext = {
  requestContext?: { get(key: string): unknown };
  tracingContext?: { currentSpan?: { traceId?: string } };
  loggerVNext?: { info(m: string, d?: object): void; warn(m: string, d?: object): void };
  /**
   * Inside an agent's loop (Mastra): suspend the run, and, when it is resumed, what it was
   * resumed with and what it suspended with. Absent elsewhere (MCP, a direct execute).
   */
  agent?: {
    suspend?(payload: unknown): Promise<unknown>;
    resumeData?: unknown;
    suspendPayload?: unknown;
  };
};
export type ClientFor = (ctx: ToolContext | undefined) => ApiClient;

/**
 * What every tool factory needs: how to call the API for a run, and the registry of views
 * its results may be shown with. Passed in, so the framework never imports a domain.
 */
export type ToolKit = { clientFor: ClientFor; registry: Registry };

/** What a successful result shows: a registered view, a screen, a page (see present.ts). */
type PresentOf<T> = (result: T) => Present | undefined;

/** A result, with what it shows on this turn's surfaces. */
async function shown<T>(
  tool: string,
  ctx: ToolContext | undefined,
  kit: ToolKit,
  result: T,
  presentOf?: PresentOf<T>,
) {
  const intent = presentOf?.(result);
  if (!intent) return { ok: true as const, result };
  const resolved = await resolvePresent(intent, ctx, kit);
  if ('error' in resolved) {
    // The framework built this intent, so a failure is a declaration bug, not the model's.
    ctx?.loggerVNext?.warn(`${tool}: present dropped`, { tool, error: resolved.error });
    return { ok: true as const, result };
  }
  return { ok: true as const, result, ...resolved };
}

/**
 * A resumed call (its run waited for an approval): the decision, never the API again. The
 * approval's replay already did the write, or did nothing; calling again would write twice.
 */
async function resumed<T>(tool: string, ctx: ToolContext, kit: ToolKit, presentOf?: PresentOf<T>) {
  const parked = isParkedCall(ctx.agent?.suspendPayload) ? ctx.agent.suspendPayload : undefined;
  const outcome = decisionOutcome(parked, ctx.agent?.resumeData);
  ctx.loggerVNext?.info(`${tool} resumed`, {
    tool,
    approvalId: parked?.approvalId,
    status: outcome.result?.status ?? (outcome.error as { error?: string }).error,
  });
  if (!outcome.ok || outcome.result.status !== 'approved') return outcome;
  return shown(tool, ctx, kit, outcome.result as T, presentOf);
}

/**
 * Refusals become data the model can explain, not exceptions that end the run. A result
 * that can be shown carries its present intent, resolved for the turn's surfaces.
 *
 * A write the API parked, inside an agent's loop, suspends the run (durable runs, A7): the
 * payload keeps what the tool shows while it waits and how to resume the turn. The run goes on
 * when the approval is decided (the `resume` feature), and this call then answers with the
 * decision instead of calling the API again.
 */
export async function safely<T>(
  tool: string,
  ctx: ToolContext | undefined,
  kit: ToolKit,
  fn: () => Promise<T>,
  presentOf?: PresentOf<T>,
) {
  if (ctx?.agent && ctx.agent.resumeData !== undefined) return resumed(tool, ctx, kit, presentOf);
  try {
    const result = await fn();
    ctx?.loggerVNext?.info(`${tool} ok`, { tool });
    const out = await shown(tool, ctx, kit, result, presentOf);
    const approval = parkedApproval(result);
    if (approval && ctx?.agent?.suspend) {
      const parked: ParkedCall = {
        kind: 'approval',
        approvalId: approval.id,
        summary: approval.summary,
        ...(typeof approval.canDecide === 'boolean' ? { canDecide: approval.canDecide } : {}),
        output: out,
        context: runContextOf(ctx.requestContext),
      };
      ctx.loggerVNext?.info(`${tool} suspended`, { tool, approvalId: approval.id });
      await ctx.agent.suspend(parked);
    }
    return out;
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
  subject: { kind: 'user', userId: 'user' },
  scopes: [],
};

function needsApproval(spec: EntitySpec, action: 'create' | 'update' | 'delete') {
  // No payload yet: a check on the input or the row sees null.
  return parksFor(spec.approval[action], agentPrincipal, { action, input: null, row: null });
}

const APPROVAL =
  ' It may wait for approval instead of running: then the run pauses, the user is told what is waiting, and the run goes on once it is decided, with this result saying how ({ status: "approved" | "rejected" | "expired" }).';

/** A parked write shows the person what is waiting, with Approve and Reject. */
function parked(result: unknown): Present | undefined {
  const r = result as WriteResult<unknown>;
  return r?.status === 'needs_approval'
    ? {
        kind: 'inline',
        view: 'approval.card',
        props: {
          approvalId: r.approval.id,
          summary: r.approval.summary,
          ...(r.approval.canDecide === false ? { canDecide: false } : {}),
        },
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
