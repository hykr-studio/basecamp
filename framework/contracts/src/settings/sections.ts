import type { z } from 'zod';
import { createHookRegistry } from '../framework/registry.js';
import { TenantSettings } from '../principal.js';

/**
 * Per-business settings that a feature owns, one section each: `models`, `credits`. Open: the
 * feature declares its section's type by declaration merging and registers its schema with
 * `defineSettingsSection`, in `contracts/src/settings/<feature>.ts`:
 *
 *   declare module '@hykr/contracts' {
 *     interface TenantSettingsSections { credits: { capMinor: number } }
 *   }
 *   export const Credits = defineSettingsSection('credits', z.object({ ... }).default(...));
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface TenantSettingsSections {}

export type SettingsKey = keyof TenantSettingsSections & string;

export interface SettingsSection<K extends SettingsKey = SettingsKey> {
  key: K;
  schema: z.ZodType<TenantSettingsSections[K]>;
}

/** Every registered section, in registration order. */
export const settingsSections = createHookRegistry<SettingsSection>(
  'settings section',
  (s) => s.key,
);

/**
 * Register a section. Its schema must give a default for everything (it parses `undefined`),
 * so a new business works as is, and its key may not be one of the base settings.
 */
export function defineSettingsSection<K extends SettingsKey>(
  key: K,
  schema: z.ZodType<TenantSettingsSections[K]>,
): SettingsSection<K> {
  if (key in TenantSettings.shape)
    throw new Error(`Settings section "${key}" would replace a base setting`);
  if (!schema.safeParse(undefined).success)
    throw new Error(`Settings section "${key}" needs a default for every field`);
  const section: SettingsSection<K> = { key, schema };
  settingsSections.register(section as unknown as SettingsSection);
  return section;
}

/** A business's settings: the base ones and every registered section, defaults applied. */
export type TenantConfig = TenantSettings & TenantSettingsSections;

/** Stored settings (the tenants row's jsonb) as a business's config. Invalid values throw. */
export function parseTenantSettings(raw: unknown): TenantConfig {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sections = settingsSections
    .all()
    .map((s) => [s.key, s.schema.parse(stored[s.key])] as const);
  return { ...TenantSettings.parse(stored), ...Object.fromEntries(sections) } as TenantConfig;
}
