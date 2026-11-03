import type { Catalog } from '@hykr/contracts';
import { toolsFor as frameworkTools, type ToolKit } from '@hykr/core/tools';

/** Which surfaces a turn can draw on decides the tool set; see agentFor. */
export type Profile = 'app' | 'inline' | 'text';

/**
 * The agent's tools come from the same declarations the API serves: every entity and
 * command in the catalog (the application's and the framework's). Nothing here names one.
 * The canvas tools exist only where a canvas can show them.
 */
export function toolsFor(kit: ToolKit, catalog: Catalog, profile: Profile) {
  return frameworkTools(kit, catalog, { canvas: profile === 'app' });
}
