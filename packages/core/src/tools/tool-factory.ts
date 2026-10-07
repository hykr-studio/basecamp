import { type ApiClient, ApiError } from '@app/api-client';
import { type CommandSpec, type EntitySpec, listInputObject, type Principal } from '@app/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

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

/** Refusals become data the model can explain, not exceptions that end the run. */
async function safely<T>(tool: string, ctx: ToolContext | undefined, fn: () => Promise<T>) {
  try {
    const result = await fn();
    ctx?.loggerVNext?.info(`${tool} ok`, { tool });
    return { ok: true as const, result };
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

export function entityTools(spec: EntitySpec, clientFor: ClientFor) {
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
      description: `${spec.description} Lists ${label}s with their ids. Filter on ${ops}: a value means equals, or use an object with eq, ne, in, lt, lte, gt, gte (dates, numbers) or contains (text). Examples: ${examples}.${list.search?.length ? ` "q" searches ${list.search.join(' and ')}.` : ''} "sort": "-field" for descending (sortable: ${list.sortable.join(', ')}). At most ${max} per call; pass nextCursor back as "cursor" for more.`,
      inputSchema: listInputObject(spec, { maxLimit: max }),
      execute: async (input, ctx) =>
        safely(`list-${plural}`, ctx, () => api(ctx).list({ limit: max, ...(input as object) })),
    });
  }
  if (exposed('get')) {
    tools[`get-${name}`] = createTool({
      id: `get-${name}`,
      description: `Get one ${label} by id.`,
      inputSchema: z.object({ id: z.string().describe(`The ${label} id`) }),
      execute: async ({ id }, ctx) => safely(`get-${name}`, ctx, () => api(ctx).get(id)),
    });
  }
  if (exposed('create')) {
    tools[`create-${name}`] = createTool({
      id: `create-${name}`,
      description: `Create a ${label}.${needsApproval(spec, 'create') ? APPROVAL : ''}`,
      inputSchema: spec.schemas.create,
      execute: async (input, ctx) =>
        safely(`create-${name}`, ctx, () => api(ctx).create(input as never)),
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
        safely(`update-${name}`, ctx, () => api(ctx).update(id as string, patch as never)),
    });
  }
  if (exposed('delete')) {
    tools[`delete-${name}`] = createTool({
      id: `delete-${name}`,
      description: `Delete a ${label} by id from list-${plural}.${needsApproval(spec, 'delete') ? ` The user must approve it before it is removed.${APPROVAL}` : ''}`,
      inputSchema: z.object({ id: z.string().describe(`The ${label} id`) }),
      execute: async ({ id }, ctx) => safely(`delete-${name}`, ctx, () => api(ctx).remove(id)),
    });
  }
  return tools;
}

export function commandTools(specs: CommandSpec[], clientFor: ClientFor) {
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const spec of specs) {
    if (!spec.tool || spec.expose !== 'all') continue;
    const id = spec.tool;
    tools[id] = createTool({
      id,
      description: `${spec.description}${spec.approvalNote ? ` ${spec.approvalNote}${APPROVAL}` : ''}`,
      inputSchema: spec.input,
      execute: async (input, ctx) =>
        safely(id, ctx, () => clientFor(ctx).command(spec, input as never)),
    });
  }
  return tools;
}
