// Roles and capabilities: which named things (the back office, the whole history, a module's
// cost column) a role allows. Framework and module code ask `can(p, capability)` (@hykr/policy),
// never a role's name, so a business can name and rearrange its roles. Both lists are
// process-global registries; applications and modules add to them through `contributes`.
import type { Labels } from '@hykr/i18n';
import { createHookRegistry } from './framework/registry.js';
import { ROLE_NAME } from './principal.js';

declare module './framework/module.js' {
  interface Contributions {
    roles: readonly RoleDef[];
    capabilities: readonly CapabilityDef[];
  }
}

/** A capability's name: an area and an action, lower case, dotted ('orders.cost.read'). */
export const CAPABILITY_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** A role a business gives its people. By itself it grants nothing: access maps and capabilities do. */
export interface RoleDef {
  /** As stored in memberships.roles: 'owner', 'team_lead'. */
  name: string;
  label: Labels;
  /** Capabilities this role has, besides those that name it (`CapabilityDef.roles`). */
  capabilities?: readonly string[];
}

/** Something a role may do that is not an entity's rows: a screen, a feature, a hidden field. */
export interface CapabilityDef {
  /** Namespaced by its owner: 'backoffice.use', 'orders.cost.read'. */
  name: string;
  label: Labels;
  /** The roles that have it by default. A role the application lacks is ignored. */
  roles?: readonly string[];
}

/** A role, checked: a valid name, and capability names that look like capabilities. */
export function defineRole(def: RoleDef): RoleDef {
  if (!ROLE_NAME.test(def.name))
    throw new Error(`Role "${def.name}": use lower case letters, digits and _ (at most 32)`);
  for (const c of def.capabilities ?? [])
    if (!CAPABILITY_NAME.test(c)) throw new Error(`Role "${def.name}": "${c}" is not a capability`);
  return def;
}

/** A capability, checked: a dotted name, and role names that look like roles. */
export function defineCapability(def: CapabilityDef): CapabilityDef {
  if (!CAPABILITY_NAME.test(def.name))
    throw new Error(`Capability "${def.name}": name it <area>.<action>, lower case`);
  for (const r of def.roles ?? [])
    if (!ROLE_NAME.test(r)) throw new Error(`Capability "${def.name}": "${r}" is not a role`);
  return def;
}

/** Every role a membership may hold. Collects `contributes.roles`. */
export const roles = createHookRegistry<RoleDef>('role', (r) => defineRole(r).name, {
  collects: 'roles',
});

/** Every capability `can()` knows. Collects `contributes.capabilities`. */
export const capabilities = createHookRegistry<CapabilityDef>(
  'capability',
  (c) => defineCapability(c).name,
  { collects: 'capabilities' },
);

/** The framework's roles, as every business had them before roles could be added. */
export const FrameworkRoles = {
  owner: defineRole({
    name: 'owner',
    label: { en: 'Owner', hi: 'मालिक', te: 'యజమాని' },
  }),
  admin: defineRole({
    name: 'admin',
    label: { en: 'Admin', hi: 'एडमिन', te: 'అడ్మిన్' },
  }),
  ops: defineRole({
    name: 'ops',
    label: { en: 'Operations', hi: 'संचालन', te: 'కార్యకలాపాలు' },
  }),
  staff: defineRole({
    name: 'staff',
    label: { en: 'Staff', hi: 'स्टाफ़', te: 'సిబ్బంది' },
  }),
  /** A customer of the business: an unlinked WhatsApp contact holds only this. */
  customer: defineRole({
    name: 'customer',
    label: { en: 'Customer', hi: 'ग्राहक', te: 'కస్టమర్' },
  }),
} as const;

const TEAM = ['owner', 'admin', 'ops', 'staff'];

/** The framework's own capabilities, with the roles that had each one before. */
export const FrameworkCapabilities = {
  /** The back office: take a WhatsApp conversation from the assistant and reply. */
  backOffice: defineCapability({
    name: 'backoffice.use',
    label: {
      en: 'Work in the back office',
      hi: 'बैक ऑफ़िस में काम करें',
      te: 'బ్యాక్ ఆఫీస్‌లో పని చేయండి',
    },
    roles: TEAM,
  }),
  /** Send a template to a customer by hand (notify.send). */
  messageCustomers: defineCapability({
    name: 'customers.message',
    label: {
      en: 'Message customers',
      hi: 'ग्राहकों को संदेश भेजें',
      te: 'కస్టమర్లకు సందేశం పంపండి',
    },
    roles: TEAM,
  }),
  /** The whole business's history, not only what you (or your assistant) did. */
  wholeHistory: defineCapability({
    name: 'history.all',
    label: {
      en: "See the whole business's history",
      hi: 'पूरे व्यवसाय का इतिहास देखें',
      te: 'మొత్తం వ్యాపార చరిత్రను చూడండి',
    },
    roles: ['admin', 'ops'],
  }),
  /** Set the business's WhatsApp number. */
  channelSetup: defineCapability({
    name: 'channels.manage',
    label: {
      en: "Set the business's WhatsApp number",
      hi: 'व्यवसाय का WhatsApp नंबर सेट करें',
      te: 'వ్యాపార WhatsApp నంబర్‌ను సెట్ చేయండి',
    },
    roles: ['owner', 'admin'],
  }),
  /** The job queues' dashboard (Bull Board, development only). */
  queues: defineCapability({
    name: 'queues.admin',
    label: {
      en: 'Open the job queues',
      hi: 'जॉब कतारें खोलें',
      te: 'జాబ్ క్యూలను తెరవండి',
    },
    roles: ['owner', 'admin'],
  }),
} as const;

roles.register(...Object.values(FrameworkRoles));
capabilities.register(...Object.values(FrameworkCapabilities));

/** The registered ones among these role names, in order, each once. */
export function knownRoles(names: readonly string[]): string[] {
  return [...new Set(names)].filter((n) => roles.has(n));
}

/**
 * What these roles allow: each role's own list, plus every capability that names the role.
 * Unknown roles add nothing. Sorted, each once.
 */
export function capabilitiesOf(roleNames: readonly string[]): string[] {
  const held = new Set(knownRoles(roleNames));
  const out = new Set<string>();
  for (const name of held) for (const c of roles.get(name)?.capabilities ?? []) out.add(c);
  for (const c of capabilities.all()) if (c.roles?.some((r) => held.has(r))) out.add(c.name);
  return [...out].sort();
}

/** Fails when a role names a capability nobody defines (a typo would grant nothing, silently). */
export function checkRoles(): void {
  for (const role of roles.all())
    for (const c of role.capabilities ?? [])
      if (!capabilities.has(c))
        throw new Error(`Role "${role.name}" names capability "${c}", which nobody defines`);
}
