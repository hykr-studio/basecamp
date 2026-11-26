// Feature flags, server side (A11): what a business has switched off, and whether a route, a
// write or a tool belongs to something that is off. Everything fails closed: no business, an
// unknown one, settings that do not parse, a flag not stored as `true` are all off.
import {
  type Catalog,
  commandToolId,
  entityToolIds,
  featureEnabled,
  featureFlags,
  type GatedOff,
  gatedOff,
} from '@hykr/contracts';
import { TenantConfigService } from '@hykr/core';
import { schema } from '@hykr/db';
import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { WriteHook } from '../../hooks.js';
import { runtime } from '../../runtime.js';

export const NOTHING_OFF: GatedOff = {
  modules: [],
  entities: [],
  commands: [],
  tools: [],
  nav: [],
};

/** What is off when only `isOn` flags are on: nothing to compute when no flag is declared. */
export const offWhen = (isOn: (key: string) => boolean): GatedOff =>
  featureFlags.all().length ? gatedOff(featureFlags.all(), isOn) : NOTHING_OFF;

/** Is this entity (by name) off: itself, or its module? */
export const entityOff = (off: GatedOff, catalog: Catalog, name: string) =>
  off.entities.includes(name) || off.modules.includes(catalog.moduleOf(name) ?? '');

/** Is this command (by name) off: itself, or its module? */
export const commandOff = (off: GatedOff, catalog: Catalog, name: string) =>
  off.commands.includes(name) || off.modules.includes(catalog.moduleOf(name) ?? '');

/** The tool ids of everything that is off: its entities', commands' and the named tools. */
export function toolsOff(off: GatedOff, catalog: Catalog): string[] {
  const ids = new Set(off.tools);
  for (const spec of Object.values(catalog.entities))
    if (entityOff(off, catalog, spec.name)) for (const id of entityToolIds(spec)) ids.add(id);
  for (const spec of catalog.commands)
    if (commandOff(off, catalog, spec.name)) {
      const id = commandToolId(spec);
      if (id) ids.add(id);
    }
  return [...ids];
}

/** The declared flags that are on in these settings. */
export const flagsOn = (settings: { features?: Record<string, unknown> } | undefined) =>
  featureFlags
    .all()
    .filter((f) => featureEnabled(settings, f.key))
    .map((f) => f.key);

/** A business's switched-off things, from its cached settings. */
@Injectable()
export class FeatureGates {
  constructor(private readonly config: TenantConfigService) {}

  async off(tenantId: string | undefined): Promise<GatedOff> {
    if (!featureFlags.all().length) return NOTHING_OFF;
    if (!tenantId) return offWhen(() => false);
    try {
      const { settings } = await this.config.get(tenantId);
      return offWhen((key) => featureEnabled(settings, key));
    } catch {
      return offWhen(() => false);
    }
  }
}

/** The 404 a switched-off thing answers: the same as a record that is not there. */
export const switchedOff = () =>
  new NotFoundException({ error: 'not_found', message: 'Not found here' });

/**
 * Every write, on every path (a route, a command calling another entity's repository, an
 * approved replay, a system job): when its operation or a record it touched belongs to something
 * the business has switched off, the whole write rolls back with a 404. The flags are read in the
 * write's transaction, so a replay approved after the switch went off fails.
 */
export const featureFlagsHook: WriteHook = {
  name: 'feature-flags',
  async afterRun({ ctx, op, tx, touched }) {
    if (!featureFlags.all().length) return;
    const catalog = runtime().catalog;
    const entities = new Set(touched.map((t) => t.type));
    if (op.kind === 'entity') entities.add(op.resourceType);
    const commands = op.kind === 'command' ? [op.name] : [];
    // Only the flags that gate something here matter; most writes have none.
    const everythingOff = offWhen(() => false);
    const gated =
      [...entities].some((e) => catalog.entityByName(e) && entityOff(everythingOff, catalog, e)) ||
      commands.some((c) => commandOff(everythingOff, catalog, c));
    if (!gated) return;
    const tenantId = ctx.principal.tenantId;
    const [row] = tenantId
      ? await tx
          .select({ settings: schema.tenants.settings })
          .from(schema.tenants)
          .where(eq(schema.tenants.id, tenantId))
      : [];
    const settings = row?.settings as { features?: Record<string, unknown> } | undefined;
    const off = offWhen((key) => featureEnabled(settings, key));
    if (
      [...entities].some((e) => catalog.entityByName(e) && entityOff(off, catalog, e)) ||
      commands.some((c) => commandOff(off, catalog, c))
    )
      throw switchedOff();
  },
};
