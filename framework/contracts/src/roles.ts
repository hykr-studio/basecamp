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
    roleOverrides: readonly RoleOverride[];
    roleDefaults: readonly RoleDefault[];
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
  /**
   * May a business give it to its roles (a role it made, or its edit of a declared one)?
   * Default true. False keeps it with the code that declares roles: something that reaches
   * beyond one business (the job queues of every business) must never be a business's choice.
   */
  grantable?: boolean;
}

/**
 * The application's change to a role someone else declared (the framework's, another
 * module's): another label, or the capabilities it has instead of its defaults. `capabilities`
 * replaces the whole default set: the role's own list and every capability naming the role.
 */
export interface RoleOverride {
  role: string;
  label?: Labels;
  capabilities?: readonly string[];
}

/**
 * The roles the framework hands out itself: to the person who creates a business (`creator`), to
 * a WhatsApp contact without an account (`contact`), and to a person who is no member of a
 * business but a member of one of its parties (`participant`). An application names its own; the
 * framework's are `owner`, `customer`, and for a participant whatever `contact` is.
 */
export interface RoleDefault {
  name: RoleDefaultName;
  roles: readonly string[];
}
export const ROLE_DEFAULT_NAMES = ['creator', 'contact', 'participant'] as const;
export type RoleDefaultName = (typeof ROLE_DEFAULT_NAMES)[number];

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

/** Application overrides of declared roles, by role name. Collects `contributes.roleOverrides`. */
export const roleOverrides = createHookRegistry<RoleOverride>('role override', (o) => o.role, {
  collects: 'roleOverrides',
});

/** The roles given to a creator, a contact and a participant. Collects `contributes.roleDefaults`. */
export const roleDefaults = createHookRegistry<RoleDefault>('role default', (d) => d.name, {
  collects: 'roleDefaults',
});

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

/** Who gets which role when the framework hands one out, unless the application says otherwise. */
const FRAMEWORK_DEFAULTS: Readonly<Record<'creator' | 'contact', readonly string[]>> = {
  creator: [FrameworkRoles.owner.name],
  contact: [FrameworkRoles.customer.name],
};

/**
 * The roles the framework gives a business's creator, a contact or a participant: the
 * application's, or its own. A participant gets the contact's unless the application names both.
 */
export function givenRoles(name: RoleDefaultName): string[] {
  const named = roleDefaults.get(name)?.roles;
  if (named) return [...named];
  return name === 'participant' ? givenRoles('contact') : [...FRAMEWORK_DEFAULTS[name]];
}

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
  /**
   * The job queues' dashboard (Bull Board, development only). It shows every business's jobs,
   * so no business may give it to a role.
   */
  queues: defineCapability({
    name: 'queues.admin',
    label: {
      en: 'Open the job queues',
      hi: 'जॉब कतारें खोलें',
      te: 'జాబ్ క్యూలను తెరవండి',
    },
    roles: ['owner', 'admin'],
    grantable: false,
  }),
  /** The business's members and roles, read only (GET /api/members). */
  readMembers: defineCapability({
    name: 'members.read',
    label: {
      en: "See the business's members",
      hi: 'व्यवसाय के सदस्य देखें',
      te: 'వ్యాపార సభ్యులను చూడండి',
    },
    roles: TEAM,
  }),
  /** Invite people, change and remove members, define and edit the business's roles. */
  manageMembers: defineCapability({
    name: 'members.manage',
    label: {
      en: 'Invite people and manage roles',
      hi: 'लोगों को आमंत्रित करें और भूमिकाएँ संभालें',
      te: 'వ్యక్తులను ఆహ్వానించండి, పాత్రలను నిర్వహించండి',
    },
    roles: ['owner', 'admin'],
  }),
  /** Give a member access to one record (an access rule's `granted` reach), and take it back. */
  grantRecords: defineCapability({
    name: 'records.grant',
    label: {
      en: 'Give people access to a record',
      hi: 'किसी रिकॉर्ड की पहुँच लोगों को दें',
      te: 'ఒక రికార్డుకు ప్రాప్తిని ఇవ్వండి',
    },
    roles: ['owner', 'admin', 'ops'],
  }),
} as const;

roles.register(...Object.values(FrameworkRoles));
capabilities.register(...Object.values(FrameworkCapabilities));

/** The registered ones among these role names, in order, each once. */
export function knownRoles(names: readonly string[]): string[] {
  return [...new Set(names)].filter((n) => roles.has(n));
}

/**
 * A declared role's capabilities, as the application has it: its override's list when it gives
 * one, else the role's own list plus every capability naming the role. Sorted, each once.
 */
export function declaredCapabilities(roleName: string): string[] {
  if (!roles.has(roleName)) return [];
  const override = roleOverrides.get(roleName)?.capabilities;
  if (override) return [...new Set(override)].sort();
  const out = new Set(roles.get(roleName)?.capabilities ?? []);
  for (const c of capabilities.all()) if (c.roles?.includes(roleName)) out.add(c.name);
  return [...out].sort();
}

/** A declared role's label, as the application has it (its override's, if any). */
export function declaredLabel(roleName: string): Labels | undefined {
  return roleOverrides.get(roleName)?.label ?? roles.get(roleName)?.label;
}

/**
 * What these declared roles allow (application overrides applied). Unknown roles add nothing.
 * Sorted, each once. A business's own roles and edits: `standingIn` (settings/roles.ts).
 */
export function capabilitiesOf(roleNames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of knownRoles(roleNames)) for (const c of declaredCapabilities(name)) out.add(c);
  return [...out].sort();
}

/** May a business give this capability to a role? Defined, and not kept for code. */
export const isGrantable = (name: string): boolean =>
  capabilities.get(name)?.grantable !== false && capabilities.has(name);

/**
 * Fails when a role or an override names a capability nobody defines (a typo would grant
 * nothing, silently), an override or default names a role nobody declares, or a default hands
 * out no role at all.
 */
export function checkRoles(): void {
  const undefinedCapability = (who: string, c: string) =>
    new Error(`${who} names capability "${c}", which nobody defines`);
  for (const role of roles.all())
    for (const c of role.capabilities ?? [])
      if (!capabilities.has(c)) throw undefinedCapability(`Role "${role.name}"`, c);
  for (const o of roleOverrides.all()) {
    if (!roles.has(o.role))
      throw new Error(`The override of role "${o.role}" names a role nobody declares`);
    for (const c of o.capabilities ?? [])
      if (!capabilities.has(c)) throw undefinedCapability(`The override of role "${o.role}"`, c);
  }
  for (const d of roleDefaults.all()) {
    if (!(ROLE_DEFAULT_NAMES as readonly string[]).includes(d.name))
      throw new Error(`Role default "${d.name}": only ${ROLE_DEFAULT_NAMES.join(', ')} exist`);
    if (!d.roles.length) throw new Error(`Role default "${d.name}" gives no role`);
    for (const r of d.roles)
      if (!roles.has(r)) throw new Error(`Role default "${d.name}" names "${r}", no role`);
  }
}
