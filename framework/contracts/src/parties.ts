// Parties and participant roles: the people and organisations a business works with who are not
// on its team. A party (a person or an organisation) is put on a record with a participant role,
// and the `participant` access grant reaches the records a person participates in. Which
// participant roles exist (and which parties and records each fits) is the application's to
// declare; the framework declares none.
import type { Labels } from '@hykr/i18n';
import { createHookRegistry } from './framework/registry.js';
import { ROLE_NAME } from './principal.js';
import { capabilities, defineCapability } from './roles.js';

declare module './framework/module.js' {
  interface Contributions {
    participantRoles: readonly ParticipantRoleDef[];
  }
}

/** What a party is: one person, or an organisation with people who act for it. */
export const PARTY_KINDS = ['person', 'organisation'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

/**
 * A role a party holds on a record, as the application names it: who may hold it and on which
 * records. By itself it reaches nothing: an entity's access gives the `participant` grant to the
 * roles it names (`{ grant: 'participant', as: [...] }`).
 */
export interface ParticipantRoleDef {
  /** As stored on a participation: lower case letters, digits and _ ('reviewer'). */
  name: string;
  label: Labels;
  /** Which kinds of party may hold it. Default: both. */
  kinds?: readonly PartyKind[];
  /** The records it applies to, by entity name. Default: every entity. */
  on?: readonly string[];
}

/** A participant role, checked: its name and kinds. */
export function defineParticipantRole(def: ParticipantRoleDef): ParticipantRoleDef {
  if (!ROLE_NAME.test(def.name))
    throw new Error(
      `Participant role "${def.name}": use lower case letters, digits and _ (at most 32)`,
    );
  for (const k of def.kinds ?? [])
    if (!PARTY_KINDS.includes(k))
      throw new Error(`Participant role "${def.name}": "${k}" is not a kind of party`);
  if (def.kinds && !def.kinds.length)
    throw new Error(`Participant role "${def.name}": name at least one kind, or leave kinds out`);
  if (def.on && !def.on.length)
    throw new Error(`Participant role "${def.name}": name at least one entity, or leave on out`);
  return def;
}

/** Every participant role. Collects `contributes.participantRoles`. */
export const participantRoles = createHookRegistry<ParticipantRoleDef>(
  'participant role',
  (r) => defineParticipantRole(r).name,
  { collects: 'participantRoles' },
);

/** Why this party may not hold this role on this record, or null when it may. */
export function participationProblem(
  role: string,
  party: { kind: string },
  resourceType: string,
): string | null {
  const def = participantRoles.get(role);
  if (!def) return `"${role}" is not a participant role`;
  if (def.kinds && !def.kinds.includes(party.kind as PartyKind))
    return `A ${party.kind} cannot be ${role}`;
  if (def.on && !def.on.includes(resourceType)) return `${role} is not a role on a ${resourceType}`;
  return null;
}

/**
 * Fails when a participant role applies to an entity this process does not serve (a typo would
 * leave the role on nothing). Run when the API or worker starts.
 */
export function checkParticipantRoles(entityNames: ReadonlySet<string>): void {
  const problems: string[] = [];
  for (const r of participantRoles.all())
    for (const e of r.on ?? [])
      if (!entityNames.has(e))
        problems.push(`Participant role "${r.name}" is on "${e}", which is no entity`);
  if (problems.length) throw new Error(`Participant roles:\n- ${problems.join('\n- ')}`);
}

/** The framework's capabilities for parties, with the roles that have them by default. */
export const PartyCapabilities = {
  /** See the business's parties, and who participates in a record you reach. */
  read: defineCapability({
    name: 'parties.read',
    label: {
      en: 'See the people and organisations the business works with',
      hi: 'व्यवसाय जिन लोगों और संगठनों के साथ काम करता है, उन्हें देखें',
      te: 'వ్యాపారం కలిసి పనిచేసే వ్యక్తులు, సంస్థలను చూడండి',
    },
    roles: ['owner', 'admin', 'ops', 'staff'],
  }),
  /** Add and change parties, their people, and who participates in a record. */
  manage: defineCapability({
    name: 'parties.manage',
    label: {
      en: 'Manage the people and organisations on records',
      hi: 'रिकॉर्ड पर लोगों और संगठनों को संभालें',
      te: 'రికార్డులపై వ్యక్తులు, సంస్థలను నిర్వహించండి',
    },
    roles: ['owner', 'admin', 'ops'],
  }),
} as const;

capabilities.register(...Object.values(PartyCapabilities));
