// A business's setup (A11): its feature flags, branding, wording and web addresses, and every
// section that opts in to the generic writer (H2). Changed by people with `settings.manage` (or
// a section's own capability) through these commands (no tools: the assistant does not change a
// business's setup).
import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';
import { capabilities, defineCapability } from '../roles.js';
import { Branding, BrandingPatch, DomainOrigin, TenantDomain } from '../settings/branding.js';
import { GatedOff } from '../settings/features.js';
import { SETTINGS_MANAGE } from '../settings/sections.js';
import { SomeLabels, Wording, WordingPatch } from '../settings/wording.js';

/** Change the business's setup: flags it may switch, branding, wording, domains, custom fields. */
export const SettingsCapability = defineCapability({
  name: SETTINGS_MANAGE,
  label: {
    en: "Change the business's settings",
    hi: 'व्यवसाय की सेटिंग बदलें',
    te: 'వ్యాపార సెట్టింగ్‌లను మార్చండి',
  },
  roles: ['owner', 'admin'],
  supportable: false,
});
capabilities.register(SettingsCapability);

/** What the apps need of a business's settings, in one call (GET /api/settings). */
export const ClientSettings = z.object({
  /** The declared flags that are on. */
  features: z.array(z.string()),
  /** What the flags that are off switch off. */
  off: GatedOff,
  branding: Branding,
  /** The business's own framework phrases (the app's tenant layer). */
  phrases: z.record(z.string(), SomeLabels),
});
export type ClientSettings = z.infer<typeof ClientSettings>;

export const SetFeatureSpec = commandSpec({
  name: 'settings.feature',
  description: 'Switch one of the business’s own feature flags on or off.',
  input: z.object({ key: z.string().min(1).max(100), on: z.boolean() }),
  output: z.object({ key: z.string(), on: z.boolean() }),
  http: { method: 'PUT', path: '/api/features/:key' },
  expose: 'human',
  verb: { do: 'switch', did: 'switched' },
});

export const UpdateBrandingSpec = commandSpec({
  name: 'settings.branding',
  description: "Change the business's name, logo and colours in the app.",
  input: BrandingPatch,
  output: Branding,
  http: { method: 'PATCH', path: '/api/settings/branding' },
  expose: 'human',
  verb: { do: 'change the branding', did: 'changed the branding' },
});

export const UpdateWordingSpec = commandSpec({
  name: 'settings.wording',
  description: 'Word framework phrases and notification emails the business’s own way.',
  input: WordingPatch,
  output: Wording,
  http: { method: 'PATCH', path: '/api/settings/wording' },
  expose: 'human',
  verb: { do: 'change the wording', did: 'changed the wording' },
});

export const AddDomainSpec = commandSpec({
  name: 'settings.domain.add',
  description: 'Add a web address for the business; it is trusted once verified.',
  input: z.object({ origin: DomainOrigin }),
  output: TenantDomain,
  http: { method: 'POST', path: '/api/settings/domains' },
  expose: 'human',
  verb: { do: 'add the address', did: 'added the address' },
});

export const VerifyDomainSpec = commandSpec({
  name: 'settings.domain.verify',
  description: 'Check the TXT record of a web address, and trust it when it holds the token.',
  input: z.object({ domainId: z.uuid() }),
  output: TenantDomain,
  http: { method: 'POST', path: '/api/settings/domains/:domainId/verify' },
  expose: 'human',
  verb: { do: 'verify the address', did: 'verified the address' },
});

export const RemoveDomainSpec = commandSpec({
  name: 'settings.domain.remove',
  description: 'Stop serving the business on a web address.',
  input: z.object({ domainId: z.uuid() }),
  output: z.object({ id: z.string() }),
  http: { method: 'DELETE', path: '/api/settings/domains/:domainId' },
  expose: 'human',
  verb: { do: 'remove the address', did: 'removed the address' },
});

/**
 * One section the business changes with the generic writer (`settings.section`), as the people
 * who may change it read it. `general` is the base settings' editable part.
 */
export const SettingsSectionView = z.object({
  key: z.string(),
  /** Who may read and change it. */
  capability: z.string(),
  /** Its value, defaults applied; null when what is stored no longer parses. */
  value: z.unknown(),
  /** Why what is stored no longer parses: fix it with the same patch. Empty otherwise. */
  problems: z.array(z.string()),
});
export type SettingsSectionView = z.infer<typeof SettingsSectionView>;

/**
 * PATCH /api/settings/sections/:section { value }: a JSON merge patch of one section (an
 * object changes key by key, null restores a key's default, anything else replaces). Checked
 * by the section's schema and the settings checks, unknown keys refused (400 settings_invalid).
 */
export const UpdateSettingsSectionSpec = commandSpec({
  name: 'settings.section',
  description:
    "Change one section of the business's settings (approvals, money, business hours, SLAs …).",
  input: z.object({
    section: z.string().min(1).max(64),
    value: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ key: z.string(), value: z.unknown() }),
  http: { method: 'PATCH', path: '/api/settings/sections/:section' },
  expose: 'human',
  verb: { do: 'change the settings', did: 'changed the settings' },
});

/** The settings commands, for clients (`api.command(spec, input)`). */
export const settingsCommands = [
  SetFeatureSpec,
  UpdateBrandingSpec,
  UpdateWordingSpec,
  AddDomainSpec,
  VerifyDomainSpec,
  RemoveDomainSpec,
  UpdateSettingsSectionSpec,
] as const;
