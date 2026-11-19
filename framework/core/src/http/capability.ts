import type { CapabilityDef } from '@hykr/contracts';
import { can } from '@hykr/policy';
import { ForbiddenException } from '@nestjs/common';

/**
 * Refuse unless the principal has this capability: 403 `{ error: 'forbidden', rule, reason }`,
 * like a denied write. `rule` defaults to 'missing_capability'.
 */
export function requireCapability(
  p: { capabilities?: readonly string[] | null },
  capability: string | CapabilityDef,
  refusal: { rule?: string; reason?: string } = {},
): void {
  if (can(p, capability)) return;
  const name = typeof capability === 'string' ? capability : capability.name;
  throw new ForbiddenException({
    error: 'forbidden',
    rule: refusal.rule ?? 'missing_capability',
    reason: refusal.reason ?? `This needs ${name}`,
  });
}
