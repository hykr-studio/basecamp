import type { CommandSpec, EntitySpec } from '@app/contracts';
import { canvasTools } from './canvas-tools.js';
import { commandTools, entityTools, type ToolKit } from './tool-factory.js';

/**
 * Every tool for a set of entities and commands (the domain's and the framework's), plus the
 * canvas tools where a canvas exists. Adding an entity or a command to the domain adds its
 * tools here; nothing names an entity.
 */
export function toolsFor(
  kit: ToolKit,
  catalog: { entities: Record<string, EntitySpec>; commands: readonly CommandSpec[] },
  options: { canvas: boolean },
) {
  return {
    ...Object.assign({}, ...Object.values(catalog.entities).map((spec) => entityTools(spec, kit))),
    ...commandTools(catalog.commands, kit),
    ...(options.canvas ? canvasTools(kit) : {}),
  } as ReturnType<typeof entityTools>;
}
