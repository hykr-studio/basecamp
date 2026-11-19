import { type ApiClient, runReadTool } from '@hykr/api-client';
import { type ChatContext, type EntitySpec, entityReadTools } from '@hykr/contracts';
import { z } from 'zod';
import type { WebMcpTool } from './adapter';

/**
 * The WebMCP tools for one screen: the assistant's read tools (`list-<plural>`, `get-<name>`)
 * of each entity it reads, with the same ids, wording and input. Each one runs through
 * `client`, so with the person's session and nothing more: the API applies their business,
 * their access and field hiding to every call. Only actions open to agents become tools.
 */
export function webMcpTools(options: {
  /** The catalog, or any map of specs by plural. */
  catalog: { entities: Readonly<Record<string, EntitySpec>> };
  /** The entities the screen reads, by plural (its WebMCP declaration). */
  reads: readonly string[];
  client: Pick<ApiClient, 'entity'>;
  /** Where the person is: a record it names is the one `get-<name>` says is open. */
  context?: ChatContext;
}): WebMcpTool[] {
  const { catalog, client, context } = options;
  const tools = new Map<string, WebMcpTool>();
  for (const plural of options.reads) {
    if (!Object.hasOwn(catalog.entities, plural)) continue;
    const spec = catalog.entities[plural];
    for (const tool of entityReadTools(spec)) {
      if (tools.has(tool.id)) continue;
      const record = context?.record;
      const open =
        tool.action === 'get' && record?.type === spec.name
          ? ` The screen shows the ${spec.label} with id ${record.id}.`
          : '';
      tools.set(tool.id, {
        name: tool.id,
        title: tool.title,
        description: `${tool.description}${open}`,
        inputSchema: z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }),
        // Records hold what people and contacts typed: data for the agent, not instructions.
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input) => JSON.stringify(await runReadTool(client, tool, input)),
      });
    }
  }
  return [...tools.values()];
}
