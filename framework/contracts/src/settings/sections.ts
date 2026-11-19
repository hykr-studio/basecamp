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
 *
 * Pass `{ editable: true }` (or `{ editable: { capability } }`) to let the business change it
 * with `PATCH /api/settings/sections/:key`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface TenantSettingsSections {}

export type SettingsKey = keyof TenantSettingsSections & string;

/** The capability that changes a business's setup: owners and admins (platform/settings.ts). */
export const SETTINGS_MANAGE = 'settings.manage';

/**
 * The base settings' editable part, written like a section (`PATCH /api/settings/sections/general`):
 * no section may take the name.
 */
export const GENERAL_SETTINGS = 'general';

export interface SettingsSection<K extends SettingsKey = SettingsKey> {
  key: K;
  schema: z.ZodType<TenantSettingsSections[K]>;
  /**
   * Changed with `PATCH /api/settings/sections/:key`, by people with this capability. Absent:
   * only the section's own feature changes it (its own route, with its own checks).
   */
  editable?: { capability: string };
}

/** How a section may be changed by the business (`defineSettingsSection`'s third argument). */
export interface SettingsSectionOptions {
  /**
   * `true`: holders of `settings.manage` change it with the generic writer. `{ capability }`:
   * holders of that one. Leave it out when the feature keeps its own writer.
   */
  editable?: true | { capability: string };
}

/** Every registered section, in registration order. */
export const settingsSections = createHookRegistry<SettingsSection>(
  'settings section',
  (s) => s.key,
);

/**
 * Register a section. Its schema must give a default for everything (it parses `undefined`),
 * so a new business works as is, and its key may not be one of the base settings. With
 * `editable`, the business changes it through the generic writer (docs/decisions/H2.md).
 */
export function defineSettingsSection<K extends SettingsKey>(
  key: K,
  schema: z.ZodType<TenantSettingsSections[K]>,
  options: SettingsSectionOptions = {},
): SettingsSection<K> {
  if (key in TenantSettings.shape || (key as string) === GENERAL_SETTINGS)
    throw new Error(`Settings section "${key}" would replace a base setting`);
  if (!schema.safeParse(undefined).success)
    throw new Error(`Settings section "${key}" needs a default for every field`);
  const { editable } = options;
  const section: SettingsSection<K> = {
    key,
    schema,
    ...(editable
      ? { editable: { capability: editable === true ? SETTINGS_MANAGE : editable.capability } }
      : {}),
  };
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

/** The sections a business changes with the generic writer, in registration order. */
export const editableSections = (): readonly SettingsSection[] =>
  settingsSections.all().filter((s) => s.editable);

/** One editable section, or undefined: unknown, or kept by its own feature's writer. */
export function editableSection(key: string): SettingsSection | undefined {
  const section = settingsSections.get(key);
  return section?.editable ? section : undefined;
}
