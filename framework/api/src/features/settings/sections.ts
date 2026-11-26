// The generic settings writer (docs/decisions/H2.md): every section declared `editable`, and the
// base settings' editable part (`general`), changed with one command through the write path:
// validated by the section's schema and the settings checks, unknown keys refused, authorized by
// the section's capability, audited with the section before and after, and announced after commit
// (`settings.changed`) so caches drop their copy.
import {
  atLeast,
  capabilities,
  editableSection,
  editableSections,
  GENERAL_KEYS,
  GENERAL_SETTINGS,
  GeneralSettings,
  isEditableSettings,
  type Principal,
  patchSettings,
  SETTINGS_MANAGE,
  type SettingsSectionView,
  settingsIssues,
  storedGeneral,
  UpdateSettingsSectionSpec,
} from '@hykr/contracts';
import { allow, defineCommand, deny, type Tx } from '@hykr/core';
import { schema } from '@hykr/db';
import { can } from '@hykr/policy';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { runtime } from '../../runtime.js';
import {
  SettingsChanged,
  storedSettings,
  tenantOf,
  touchedTenant,
  writeSection,
} from './commands.js';
import { settingsChecks } from './section-checks.js';

type Values = Record<string, unknown>;

/** Something the generic writer changes: a section, or the base settings' `general`. */
export interface SettingsTarget {
  key: string;
  capability: string;
  schema: z.ZodType;
  /** What the business set, from its stored settings (undefined: nothing yet). */
  stored(settings: Values): unknown;
  /** Keep what the business set now, leaving everything else as it is. */
  write(tx: Tx, tenantId: string, stored: unknown): Promise<void>;
}

const generalTarget: SettingsTarget = {
  key: GENERAL_SETTINGS,
  capability: SETTINGS_MANAGE,
  schema: GeneralSettings,
  stored: (settings) => storedGeneral(settings),
  // The base settings are top-level keys: set the ones the business set, drop the others.
  write: async (tx, tenantId, stored) => {
    const set = (stored ?? {}) as Values;
    const { tenants } = schema;
    let value: SQL = sql`coalesce(${tenants.settings}, '{}'::jsonb)`;
    for (const k of GENERAL_KEYS) if (!(k in set)) value = sql`(${value}) - ${k}::text`;
    value = sql`(${value}) || ${JSON.stringify(set)}::jsonb`;
    await tx.update(tenants).set({ settings: value }).where(eq(tenants.id, tenantId));
  },
};

/** The editable thing by this key, or undefined: unknown, or kept by its own feature's writer. */
export function settingsTarget(key: string): SettingsTarget | undefined {
  if (key === GENERAL_SETTINGS) return generalTarget;
  const section = editableSection(key);
  if (!section?.editable) return undefined;
  return {
    key,
    capability: section.editable.capability,
    schema: section.schema,
    stored: (settings) => settings[key],
    write: (tx, tenantId, stored) => writeSection(tx, tenantId, key, stored),
  };
}

/** Every editable thing: `general` first, then the sections in registration order. */
export const settingsTargets = (): SettingsTarget[] => [
  generalTarget,
  ...editableSections().flatMap((s) => settingsTarget(s.key) ?? []),
];

/** One editable thing as its managers read it: its value with defaults, or why it does not parse. */
export function sectionView(target: SettingsTarget, settings: Values): SettingsSectionView {
  const stored = target.stored(settings);
  const parsed = target.schema.safeParse(stored);
  return {
    key: target.key,
    capability: target.capability,
    value: parsed.success ? parsed.data : null,
    problems: parsed.success ? [] : settingsIssues(parsed.error, target.key),
  };
}

/** The rule a refusal names: needs_settings_manage, needs_<area>_<action> for another capability. */
export const capabilityRule = (capability: string) => `needs_${capability.replaceAll('.', '_')}`;

/**
 * Who may change it: a person, signed in, holding the target's capability; or server code (the
 * system principal). Never the assistant.
 */
export function mayChange(p: Principal, target: SettingsTarget) {
  if (p.actor.kind === 'system') return allow('system_settings', 'Server code sets it up');
  if (p.actor.kind !== 'user')
    return deny('people_only', "A person changes the business's settings");
  if (!can(p, target.capability))
    return deny(
      capabilityRule(target.capability),
      `Only someone who may change the ${target.key} settings can do this`,
    );
  if (!atLeast(p.assurance, 'session'))
    return deny('needs_assurance', "Change the business's settings in the app, signed in");
  return allow('settings_manager', 'May change these settings');
}

const invalid = (problems: readonly string[]) =>
  new BadRequestException({
    error: 'settings_invalid',
    message: problems.join('; '),
    problems,
  });

type Next = { before: unknown; stored: unknown; value: unknown };
type Loaded = { target: SettingsTarget; tenantId: string; next: Next | null };

/**
 * The section's next value, checked: what the business set merged with the patch, parsed by
 * the section's schema (unknown keys refused), then every settings check of the section, in the
 * write's transaction. Throws 400 settings_invalid with the problems.
 */
async function nextValue(
  tx: Tx,
  p: Principal,
  target: SettingsTarget,
  tenantId: string,
  settings: Values,
  patch: Values,
): Promise<Next> {
  const before = target.stored(settings);
  const next = patchSettings(target.schema, before, patch, target.key);
  if (!next.ok) throw invalid(next.problems);
  const problems: string[] = [];
  const ctx = { tx, tenantId, principal: p, catalog: runtime().catalog };
  for (const check of settingsChecks.all())
    if (check.section === target.key)
      problems.push(...(await check.check(next.value as never, ctx)));
  if (problems.length) throw invalid(problems);
  return { before, stored: next.stored, value: next.value };
}

/**
 * PATCH /api/settings/sections/:section { value }: a merge patch of one section. The change is
 * checked when it is loaded, so a refused value is refused at once, even where an application's
 * level rule would have it wait; an approval's replay loads, and so checks, it again. Someone who
 * may not change the section is refused (and audited) without it being checked.
 */
export const UpdateSettingsSection = defineCommand(UpdateSettingsSectionSpec, {
  resource: { type: 'tenant', id: (_input, loaded: Loaded) => loaded.tenantId },
  load: async (tx, p, input) => {
    const target = settingsTarget(input.section);
    if (!target)
      throw new NotFoundException({
        error: 'not_found',
        message: `No settings section "${input.section}" is changed here`,
      });
    const tenantId = tenantOf(p);
    const settings = await storedSettings(tx, tenantId);
    const allowed = mayChange(p, target).decision === 'allow';
    return {
      target,
      tenantId,
      next: allowed ? await nextValue(tx, p, target, tenantId, settings, input.value) : null,
    };
  },
  authorize: (p, { target }) => mayChange(p, target),
  summarize: (input) => `Change the ${input.section} settings`,
  run: async ({ tx, loaded: { target, tenantId, next } }) => {
    if (!next) throw new Error('A settings change ran without being checked');
    await target.write(tx, tenantId, next.stored);
    return {
      value: { key: target.key, value: next.value },
      touched: [
        touchedTenant(
          tenantId,
          { [target.key]: next.before ?? null },
          { [target.key]: next.stored },
        ),
      ],
      events: [new SettingsChanged(tenantId, target.key)],
    };
  },
});

/**
 * Checked when the process starts: every editable section's capability is declared (else
 * nobody could change it), and every settings check names something editable (else it would
 * never run).
 */
@Injectable()
export class SettingsSectionsCheck implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    const problems: string[] = [];
    for (const s of editableSections())
      if (s.editable && !capabilities.has(s.editable.capability))
        problems.push(
          `The settings section ${s.key} is changed with "${s.editable.capability}", which nobody defines`,
        );
    for (const c of settingsChecks.all())
      if (!isEditableSettings(c.section))
        problems.push(`The settings check ${c.name} checks "${c.section}", which is not editable`);
    if (problems.length) throw new Error(`Settings sections:\n- ${problems.join('\n- ')}`);
  }
}
