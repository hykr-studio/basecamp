import { commands, entities } from '@app/contracts';
import { toolsFor as frameworkTools } from '@app/core/tools';
import { registry } from '@app/ui-registry';
import { apiFor } from '../context.js';

/** Which surfaces a turn can draw on decides the tool set; see agentFor. */
export type Profile = 'app' | 'inline' | 'text';

const kit = { clientFor: apiFor, registry };

/**
 * The agent's tools come from the same declarations the API serves: every entity and
 * command in the catalog (the domain's and the framework's). Nothing here names one.
 */
export const tools = frameworkTools(kit, { entities, commands }, { canvas: false });

/** The canvas tools exist only where a canvas can show them. */
export function toolsFor(profile: Profile) {
  return frameworkTools(kit, { entities, commands }, { canvas: profile === 'app' });
}
