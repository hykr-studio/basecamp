import type { CommandSpec, EntitySpec } from '@hykr/contracts';
import type { ToolsInput } from '@mastra/core/agent';
import { canvasTools } from './canvas-tools.js';
import { toolContributions } from './contributions.js';
import { summaryTools } from './summary-tools.js';
import { commandTools, entityTools, type ToolKit } from './tool-factory.js';

/** Tools by id, and who defined each one ('entity task', 'contribution memory'). */
export type ToolSet = { tools: ToolsInput; owners: ReadonlyMap<string, string> };

/** Adds `more` to `into`, refusing an id that is already someone's. */
function merge(into: ToolSet, from: string, more: ToolsInput): ToolSet {
  const tools = { ...into.tools };
  const owners = new Map(into.owners);
  for (const [id, tool] of Object.entries(more)) {
    const taken = owners.get(id);
    if (taken) throw new Error(`The tool "${id}" is defined twice: by ${taken} and by ${from}`);
    owners.set(id, from);
    tools[id] = tool;
  }
  return { tools, owners };
}

/**
 * The tools generated from a set of entities and commands (the domain's and the framework's),
 * plus the canvas tools where a canvas exists. Adding an entity or a command to the domain adds
 * its tools here; nothing names an entity. Two specs that make the same tool id throw.
 */
export function generatedTools(
  kit: ToolKit,
  catalog: { entities: Record<string, EntitySpec>; commands: readonly CommandSpec[] },
  options: { canvas: boolean },
): ToolSet {
  let set: ToolSet = { tools: {}, owners: new Map() };
  for (const spec of Object.values(catalog.entities)) {
    set = merge(set, `entity ${spec.name}`, entityTools(spec, kit));
    set = merge(set, `entity ${spec.name}`, summaryTools(spec, kit));
  }
  for (const spec of catalog.commands)
    set = merge(set, `command ${spec.name}`, commandTools([spec], kit));
  if (options.canvas) set = merge(set, 'the canvas', canvasTools(kit));
  return set;
}

/**
 * `set` plus every contributed tool (`toolContributions`), built for one run. A contributed id
 * that is already taken, by a generated tool or another contribution, throws.
 */
export function withContributions(kit: ToolKit, set: ToolSet): ToolSet {
  let out = set;
  for (const c of toolContributions.all()) out = merge(out, `contribution ${c.name}`, c.tools(kit));
  return out;
}

/** Every tool the agent gets: generated and contributed, each id defined once. */
export function toolsFor(
  kit: ToolKit,
  catalog: { entities: Record<string, EntitySpec>; commands: readonly CommandSpec[] },
  options: { canvas: boolean },
): ToolsInput {
  return withContributions(kit, generatedTools(kit, catalog, options)).tools;
}
