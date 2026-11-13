// Changing a business's setup (A11), through the write path like any other write: validated,
// idempotent, authorized (`settings.manage`), audited, and announced after commit
// (`settings.changed`) so every process drops its cached copy.
import { randomBytes } from 'node:crypto';
import {
  AddDomainSpec,
  Branding,
  domainRecordName,
  type FeatureFlagDef,
  featureFlags,
  isPrototypeKey,
  type Principal,
  phraseProblems,
  RemoveDomainSpec,
  SetFeatureSpec,
  SetTimeZoneSpec,
  SettingsCapability,
  type TenantDomain,
  UpdateBrandingSpec,
  UpdateWordingSpec,
  VerifyDomainSpec,
  Wording,
} from '@hykr/contracts';
import {
  allow,
  defineCommand,
  deny,
  type NamedEvent,
  type Tx,
  tenantZone,
  zoneName,
} from '@hykr/core';
import { schema } from '@hykr/db';
import { can } from '@hykr/policy';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { runtime } from '../../runtime.js';
import { txtHolds } from './domains.js';

type Values = Record<string, unknown>;
/** What a settings command loads: the business and its stored settings (locked). */
type Loaded = { tenantId: string; settings: Values };

/** Something in a business's settings changed: caches drop their copy (after commit). */
export class SettingsChanged implements NamedEvent {
  readonly eventName = 'settings.changed';
  readonly resourceType = 'tenant';
  constructor(
    readonly tenantId: string,
    readonly section: string,
    readonly origin?: string,
  ) {}
  get row() {
    return {
      id: this.tenantId,
      tenantId: this.tenantId,
      section: this.section,
      origin: this.origin,
    };
  }
  get resourceId() {
    return this.tenantId;
  }
}

const manage = (p: Principal) =>
  can(p, SettingsCapability)
    ? allow('settings_manager')
    : deny('needs_settings_manage', "Only someone who manages the business's settings can do this");

/** The principal's business, or 404: there is no business to set up. */
export const tenantOf = (p: Principal) => {
  if (!p.tenantId) throw new NotFoundException({ error: 'not_found', message: 'No business' });
  return p.tenantId;
};

/** The business's stored settings, locked for this write. */
export async function storedSettings(tx: Tx, tenantId: string): Promise<Values> {
  const [row] = await tx
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .for('update');
  if (!row) throw new NotFoundException({ error: 'not_found', message: 'No business' });
  return (row.settings as Values | null) ?? {};
}

/** Replace one top-level section of the stored settings, leaving the others as they are. */
export async function writeSection(tx: Tx, tenantId: string, section: string, value: unknown) {
  await tx
    .update(schema.tenants)
    .set({
      settings: sql`jsonb_set(coalesce(${schema.tenants.settings}, '{}'::jsonb), ${`{${section}}`}::text[], ${JSON.stringify(value)}::jsonb)`,
    })
    .where(eq(schema.tenants.id, tenantId));
}

/** The business as a write's touched record: its settings before and after. */
export const touchedTenant = (tenantId: string, before: unknown, after: unknown) => ({
  type: 'tenant',
  id: tenantId,
  change: 'updated' as const,
  before,
  after,
});

/** PUT /api/features/:key: a flag the business manages itself, on or off. */
export const SetFeature = defineCommand(SetFeatureSpec, {
  resource: {
    type: 'tenant',
    id: (_input, loaded: Loaded & { flag: FeatureFlagDef }) => loaded.tenantId,
  },
  load: async (tx, p, input) => {
    const flag = featureFlags.get(input.key);
    if (!flag) throw new NotFoundException({ error: 'not_found', message: 'No such feature' });
    const tenantId = tenantOf(p);
    return { flag, tenantId, settings: await storedSettings(tx, tenantId) };
  },
  authorize: (p, { flag }) => {
    if (p.actor.kind === 'system') return allow('platform_switch');
    if ((flag.managedBy ?? 'platform') !== 'tenant')
      return deny('platform_managed', 'Only the platform switches this feature');
    return manage(p);
  },
  summarize: (input) => `Switch ${input.key} ${input.on ? 'on' : 'off'}`,
  run: async ({ tx, input, loaded: { tenantId, settings } }) => {
    const before = (settings.features as Values | undefined) ?? {};
    const after = { ...before, [input.key]: input.on };
    await writeSection(tx, tenantId, 'features', after);
    return {
      value: { key: input.key, on: input.on },
      touched: [touchedTenant(tenantId, { features: before }, { features: after })],
      events: [new SettingsChanged(tenantId, 'features')],
    };
  },
});

/** PATCH /api/settings/branding: name, logo and colours; null clears one. */
export const UpdateBranding = defineCommand(UpdateBrandingSpec, {
  resource: { type: 'tenant', id: (_input, loaded: Loaded) => loaded.tenantId },
  load: async (tx, p) => {
    const tenantId = tenantOf(p);
    return { tenantId, settings: await storedSettings(tx, tenantId) };
  },
  authorize: (p) => manage(p),
  summarize: () => 'Change the branding',
  run: async ({ tx, input, loaded: { tenantId, settings } }) => {
    const before = Branding.parse(settings.branding);
    const after = Branding.parse({
      ...before,
      ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'colors')),
      colors: { ...before.colors, ...(input.colors ?? {}) },
    });
    await writeSection(tx, tenantId, 'branding', after);
    return {
      value: after,
      touched: [touchedTenant(tenantId, { branding: before }, { branding: after })],
      events: [new SettingsChanged(tenantId, 'branding')],
    };
  },
});

/** PATCH /api/settings/wording: the business's own phrases and notification emails. */
export const UpdateWording = defineCommand(UpdateWordingSpec, {
  resource: { type: 'tenant', id: (_input, loaded: Loaded) => loaded.tenantId },
  load: async (tx, p) => {
    const tenantId = tenantOf(p);
    return { tenantId, settings: await storedSettings(tx, tenantId) };
  },
  authorize: (p) => manage(p),
  summarize: () => 'Change the wording',
  run: async ({ tx, input, loaded: { tenantId, settings } }) => {
    const before = Wording.parse(settings.wording);
    const merge = <T>(base: Record<string, T>, patch: Record<string, T | null> | undefined) => {
      const out = { ...base };
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (isPrototypeKey(k)) continue; // never a phrase or a notification; reaches a prototype
        if (v === null) delete out[k];
        else out[k] = v;
      }
      return out;
    };
    const after = Wording.parse({
      phrases: merge(before.phrases, input.phrases),
      notifications: merge(before.notifications, input.notifications),
    });
    const problems = phraseProblems(input.phrases ? (after.phrases as never) : {});
    const emails = runtime().notifications.notifications;
    for (const key of Object.keys(input.notifications ?? {})) {
      if (input.notifications?.[key] === null) continue;
      const def = emails.find((n) => n.key === key);
      if (!def) problems.push(`"${key}" is not a notification`);
      else if (!def.email) problems.push(`"${key}" sends no email`);
    }
    if (problems.length)
      throw new BadRequestException({
        error: 'wording_invalid',
        message: problems.join('; '),
        problems,
      });
    await writeSection(tx, tenantId, 'wording', after);
    return {
      value: after,
      touched: [touchedTenant(tenantId, { wording: before }, { wording: after })],
      events: [new SettingsChanged(tenantId, 'wording')],
    };
  },
});

/**
 * PUT /api/settings/time-zone: the business's own zone, or null for the deployment's. The zone
 * is UTC or an IANA Area/Location name that Intl and Postgres both know and read alike
 * (`zoneName`): never an offset or an abbreviation, which the two read differently. It is
 * stored as Postgres spells it. Its periods, hours and dates follow it from the next write on:
 * numbers, credit periods and SLA clocks already started keep theirs.
 */
export const SetTimeZone = defineCommand(SetTimeZoneSpec, {
  resource: { type: 'tenant', id: (_input, loaded: Loaded) => loaded.tenantId },
  load: async (tx, p) => {
    const tenantId = tenantOf(p);
    return { tenantId, settings: await storedSettings(tx, tenantId) };
  },
  authorize: (p) => manage(p),
  summarize: (input) =>
    input.timeZone ? `Set the time zone to ${input.timeZone}` : "Use the deployment's time zone",
  run: async ({ tx, input, loaded: { tenantId, settings } }) => {
    const after = input.timeZone === null ? null : await zoneName(tx, input.timeZone);
    if (input.timeZone !== null && after === null)
      throw new BadRequestException({
        error: 'time_zone_invalid',
        message: `"${input.timeZone}" is not a time zone this server can use: give UTC or an IANA name such as Europe/Berlin, not an offset or an abbreviation`,
      });
    const before = typeof settings.timeZone === 'string' ? settings.timeZone : null;
    await tx
      .update(schema.tenants)
      .set({
        settings:
          after === null
            ? sql`coalesce(${schema.tenants.settings}, '{}'::jsonb) - 'timeZone'`
            : sql`jsonb_set(coalesce(${schema.tenants.settings}, '{}'::jsonb), '{timeZone}', ${JSON.stringify(after)}::jsonb)`,
      })
      .where(eq(schema.tenants.id, tenantId));
    return {
      value: { timeZone: after, effective: tenantZone({ timeZone: after }) },
      touched: [touchedTenant(tenantId, { timeZone: before }, { timeZone: after })],
      events: [new SettingsChanged(tenantId, 'timeZone')],
    };
  },
});

const domains = schema.tenantDomains;

/** A stored domain as its business sees it. */
export function domainView(row: typeof domains.$inferSelect): TenantDomain {
  return {
    id: row.id,
    origin: row.origin,
    record: { name: domainRecordName(row.origin), value: row.token },
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One of this business's domains, or 404 (another business's too). */
async function ownDomain(tx: Tx, p: Principal, id: string) {
  const [row] = await tx
    .select()
    .from(domains)
    .where(and(eq(domains.id, id), eq(domains.tenantId, tenantOf(p))))
    .limit(1);
  if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such domain' });
  return row;
}

/** POST /api/settings/domains: a new address, pending until its TXT record is verified. */
export const AddDomain = defineCommand(AddDomainSpec, {
  resource: { type: 'tenantDomain', id: () => null },
  load: async (tx, p, input) => {
    // Taken: verified by any business, or already claimed by this one. Another business's
    // pending claim does not block it: the first to verify holds the origin.
    const [taken] = await tx
      .select({ id: domains.id })
      .from(domains)
      .where(
        and(
          eq(domains.origin, input.origin),
          or(isNotNull(domains.verifiedAt), eq(domains.tenantId, tenantOf(p))),
        ),
      )
      .limit(1);
    return { tenantId: tenantOf(p), taken: !!taken };
  },
  authorize: (p) => manage(p),
  summarize: (input) => `Add the address ${input.origin}`,
  run: async ({ tx, principal, input, loaded: { tenantId, taken } }) => {
    if (taken)
      throw new ConflictException({
        error: 'domain_taken',
        message: 'This address is already registered',
      });
    const [row] = await tx
      .insert(domains)
      .values({
        tenantId,
        origin: input.origin,
        token: randomBytes(16).toString('hex'),
        createdBy:
          principal.subject?.kind === 'user' ? principal.subject.userId : principal.actor.id,
      })
      .returning();
    return {
      value: domainView(row),
      touched: [{ type: 'tenantDomain', id: row.id, change: 'created', after: domainView(row) }],
    };
  },
});

/** POST /api/settings/domains/:domainId/verify: trusted once the TXT record holds the token. */
export const VerifyDomain = defineCommand(VerifyDomainSpec, {
  resource: { type: 'tenantDomain', id: (input) => input.domainId },
  load: (tx, p, input) => ownDomain(tx, p, input.domainId),
  authorize: (p) => manage(p),
  summarize: (_input, row) => `Verify the address ${row.origin}`,
  run: async ({ tx, loaded: row }) => {
    if (row.verifiedAt) return { value: domainView(row), touched: [] };
    const [holder] = await tx
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.origin, row.origin), isNotNull(domains.verifiedAt)))
      .limit(1);
    if (holder)
      throw new ConflictException({
        error: 'domain_taken',
        message: 'Another business has verified this address',
      });
    const name = domainRecordName(row.origin);
    if (!(await txtHolds(name, row.token)))
      throw new BadRequestException({
        error: 'domain_not_verified',
        message: `The TXT record ${name} does not hold ${row.token} yet`,
      });
    const [after] = await tx
      .update(domains)
      .set({ verifiedAt: new Date() })
      .where(eq(domains.id, row.id))
      .returning();
    return {
      value: domainView(after),
      touched: [
        {
          type: 'tenantDomain',
          id: row.id,
          change: 'updated',
          before: domainView(row),
          after: domainView(after),
        },
      ],
      events: [new SettingsChanged(row.tenantId, 'domains', row.origin)],
    };
  },
});

/** DELETE /api/settings/domains/:domainId: no longer trusted, at once in this process. */
export const RemoveDomain = defineCommand(RemoveDomainSpec, {
  resource: { type: 'tenantDomain', id: (input) => input.domainId },
  load: (tx, p, input) => ownDomain(tx, p, input.domainId),
  authorize: (p) => manage(p),
  summarize: (_input, row) => `Remove the address ${row.origin}`,
  run: async ({ tx, loaded: row }) => {
    await tx.delete(domains).where(eq(domains.id, row.id));
    return {
      value: { id: row.id },
      touched: [{ type: 'tenantDomain', id: row.id, change: 'deleted', before: domainView(row) }],
      events: [new SettingsChanged(row.tenantId, 'domains', row.origin)],
    };
  },
});

export const settingsCommandDefs = [
  SetFeature,
  UpdateBranding,
  UpdateWording,
  SetTimeZone,
  AddDomain,
  VerifyDomain,
  RemoveDomain,
];
