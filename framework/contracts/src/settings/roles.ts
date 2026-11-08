// A business's own roles and its changes to the declared ones (settings section `roles`), and
// how long an invitation lasts (section `members`). Code declares roles and capabilities
// (roles.ts); each business then names, adds and rearranges roles from those capabilities,
// without a deploy. The resolver reads these per request through TenantConfigService. Roles
// have their own writer (/api/members/roles); `members` is changed through the generic settings
// writer by whoever manages members (docs/decisions/H2.md).
import { LANGS, type Labels } from '@hykr/i18n';
import { z } from 'zod';
import { ROLE_NAME } from '../principal.js';
import {
  CAPABILITY_NAME,
  capabilities,
  declaredCapabilities,
  declaredLabel,
  FrameworkCapabilities,
  FrameworkRoles,
  isGrantable,
  roles,
} from '../roles.js';
import { defineSettingsSection } from './sections.js';

/**
 * A label a business types: English required, the other languages fall back to it. Shorter
 * than code labels: it names a role in a list.
 */
export const BusinessLabel = z
  .object({
    en: z.string().trim().min(1).max(60),
    hi: z.string().trim().max(60).optional(),
    te: z.string().trim().max(60).optional(),
  })
  .transform(
    (l): Labels => Object.fromEntries(LANGS.map((lang) => [lang, l[lang] || l.en])) as Labels,
  );

/** A capability name as stored: checked against the registry when used, never when parsed. */
const CapabilityName = z.string().regex(CAPABILITY_NAME);

/** A role a business made: a name its memberships hold, a label, and its capabilities. */
export const BusinessRole = z.object({
  name: z.string().regex(ROLE_NAME),
  label: BusinessLabel,
  capabilities: z.array(CapabilityName).max(200),
});
export type BusinessRole = z.infer<typeof BusinessRole>;

/** A business's change to a declared role: another label, or capabilities instead of its own. */
export const RoleEdit = z.object({
  label: BusinessLabel.optional(),
  capabilities: z.array(CapabilityName).max(200).optional(),
});
export type RoleEdit = z.infer<typeof RoleEdit>;

export const RolesSettings = z
  .object({
    /** Roles this business made, beside the application's. */
    defined: z.array(BusinessRole).max(100).default([]),
    /** This business's changes to the application's (and the framework's) roles, by name. */
    edits: z.record(z.string().regex(ROLE_NAME), RoleEdit).default({}),
  })
  .default({ defined: [], edits: {} });
export type RolesSettings = z.infer<typeof RolesSettings>;

export const MembersSettings = z
  .object({
    /** How long an invitation can be accepted, in days. */
    inviteDays: z.number().int().min(1).max(90).default(7),
  })
  .default({ inviteDays: 7 });
export type MembersSettings = z.infer<typeof MembersSettings>;

declare module './sections.js' {
  interface TenantSettingsSections {
    roles: RolesSettings;
    members: MembersSettings;
  }
}

defineSettingsSection('roles', RolesSettings);
defineSettingsSection('members', MembersSettings, {
  editable: { capability: FrameworkCapabilities.manageMembers.name },
});

/** Where a role comes from: the framework, the application's code, or this business. */
export type RoleSource = 'framework' | 'application' | 'business';

/** A role as one business has it. */
export interface RoleView {
  name: string;
  label: Labels;
  /** What it allows here, sorted. */
  capabilities: string[];
  source: RoleSource;
  /** A declared role this business changed (its label or capabilities). */
  edited: boolean;
}

const FRAMEWORK_ROLES = new Set<string>(Object.values(FrameworkRoles).map((r) => r.name));

/**
 * The capabilities a business may give: defined, and grantable. A business's own list keeps
 * only those, plus (for a declared role) the non-grantable ones the role already had in code,
 * so editing a role never adds what only code may give.
 */
function allowed(list: readonly string[], keep: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const c of list) if (isGrantable(c) || (keep.includes(c) && capabilities.has(c))) out.add(c);
  return [...out].sort();
}

/** Every role this business has: the declared ones (with its edits), then its own. */
export function rolesOfBusiness(settings?: { roles?: RolesSettings }): RoleView[] {
  const section = settings?.roles ?? { defined: [], edits: {} };
  const declared: RoleView[] = roles.all().map((r) => {
    const edit = Object.hasOwn(section.edits, r.name) ? section.edits[r.name] : undefined;
    const code = declaredCapabilities(r.name);
    return {
      name: r.name,
      label: edit?.label ?? declaredLabel(r.name) ?? r.label,
      capabilities: edit?.capabilities ? allowed(edit.capabilities, code) : code,
      source: FRAMEWORK_ROLES.has(r.name) ? 'framework' : 'application',
      edited: Boolean(edit?.label || edit?.capabilities),
    };
  });
  // A business role whose name the application declared since is shadowed: code wins.
  const own: RoleView[] = section.defined
    .filter((r) => !roles.has(r.name))
    .map((r) => ({
      name: r.name,
      label: r.label,
      capabilities: allowed(r.capabilities),
      source: 'business',
      edited: false,
    }));
  return [...declared, ...own];
}

/**
 * What these role names amount to in one business: the ones it has (declared or its own), and
 * their capabilities with its edits. Names it does not have are `unknown`: they grant nothing.
 */
export function standingIn(
  roleNames: readonly string[],
  settings?: { roles?: RolesSettings },
): { roles: string[]; capabilities: string[]; unknown: string[] } {
  const byName = new Map(rolesOfBusiness(settings).map((r) => [r.name, r]));
  const held: string[] = [];
  const unknown: string[] = [];
  const caps = new Set<string>();
  for (const name of new Set(roleNames)) {
    const role = byName.get(name);
    if (!role) {
      unknown.push(name);
      continue;
    }
    held.push(name);
    for (const c of role.capabilities) caps.add(c);
  }
  return { roles: held, capabilities: [...caps].sort(), unknown };
}

/** Why a business may not give these capabilities, or null. */
export function capabilityProblem(list: readonly string[], keep: readonly string[] = []) {
  for (const c of list) {
    if (!capabilities.has(c)) return `"${c}" is not a capability`;
    if (!isGrantable(c) && !keep.includes(c)) return `"${c}" cannot be given by a business`;
  }
  return null;
}
