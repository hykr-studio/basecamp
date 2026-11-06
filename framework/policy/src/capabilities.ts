import { type CapabilityDef, capabilities } from '@hykr/contracts';

/**
 * May this principal do this? True only when its capabilities (worked out by the server from
 * its roles) include it: no capabilities means no. Use it instead of naming roles, so a
 * business can rename and rearrange its roles. Takes a `Me` as well, for a client's check.
 * A capability nobody defined throws: a typo must not quietly refuse everyone.
 */
export function can(
  p: { capabilities?: readonly string[] | null },
  capability: string | CapabilityDef,
): boolean {
  const name = typeof capability === 'string' ? capability : capability.name;
  if (!capabilities.has(name))
    throw new Error(`Unknown capability "${name}": define it and contribute it (capabilities)`);
  return p.capabilities?.includes(name) ?? false;
}
