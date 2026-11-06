import { z } from 'zod';
import { listInputObject } from './list.js';
import type { EntitySpec } from './spec.js';

/**
 * The read tools an entity offers an agent: its list and its get, with the ids, wording and
 * input the assistant's tools use. Isomorphic, so every agent surface (the assistant, a page's
 * WebMCP tools) names and describes them the same way. Running one is the caller's: over HTTP
 * with the caller's own credentials (`runReadTool` in @hykr/api-client).
 */

export type ReadAction = 'list' | 'get';

export interface ReadToolDef<S extends EntitySpec = EntitySpec> {
  /** As the assistant's tool: 'list-tasks', 'get-task'. */
  id: string;
  action: ReadAction;
  spec: S;
  /** Short, for people: 'List tasks'. */
  title: string;
  /** For the model: what it reads, how to filter, how to page. */
  description: string;
  /** Strict: an unknown field or operator is refused. */
  input: z.ZodObject;
  /** A list's rows per call at most (every row costs tokens), and its default. */
  maxLimit?: number;
}

/** Rows per call an agent's list asks for when the spec does not say (`list.toolPageSize`). */
export const TOOL_PAGE_SIZE = 20;

/** The read actions the spec opens to agents (`expose: 'all'`): each gives one read tool. */
export const agentReads = (spec: Pick<EntitySpec, 'expose'>): ReadAction[] =>
  (['list', 'get'] as const).filter((action) => spec.expose[action] === 'all');

/**
 * The entity's read tools: one per read action the spec exposes to agents (`expose: 'all'`).
 * A `'human'` or `'internal'` action gives none, so a spec with neither gives an empty list.
 */
export function entityReadTools<S extends EntitySpec>(
  spec: S,
  opts: { maxLimit?: number } = {},
): ReadToolDef<S>[] {
  const { name, plural, label, list } = spec;
  const max = opts.maxLimit ?? list.toolPageSize ?? TOOL_PAGE_SIZE;
  const tools: ReadToolDef<S>[] = [];
  const reads = agentReads(spec);
  if (reads.includes('list')) {
    const examples = Object.entries(list.examples ?? {})
      .map(([field, example]) => `"${field}": ${example}`)
      .join(', ');
    const ops = Object.entries(list.filterable)
      .map(([field, type]) => `${field} (${type})`)
      .join(', ');
    tools.push({
      id: `list-${plural}`,
      action: 'list',
      spec,
      title: `List ${label}s`,
      description: `${spec.description} Lists ${label}s with their ids.${ops ? ` Filter on ${ops}: a value means equals, or use an object with eq, ne, in, lt, lte, gt, gte (dates, numbers) or contains (text).` : ''}${examples ? ` Examples: ${examples}.` : ''}${list.search?.length ? ` "q" searches ${list.search.join(' and ')}.` : ''}${list.sortable.length ? ` "sort": "-field" for descending (sortable: ${list.sortable.join(', ')}).` : ''} At most ${max} per call; pass nextCursor back as "cursor" for more.`,
      input: listInputObject(spec, { maxLimit: max }),
      maxLimit: max,
    });
  }
  if (reads.includes('get')) {
    tools.push({
      id: `get-${name}`,
      action: 'get',
      spec,
      title: `Get a ${label}`,
      description: `Get one ${label} by id.`,
      input: z.object({ id: z.string().min(1).max(200).describe(`The ${label} id`) }).strict(),
    });
  }
  return tools;
}
