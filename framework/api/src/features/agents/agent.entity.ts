// The `agent` entity: who reaches which definitions, and who may change what. docs/decisions/A6.md.
import { AgentCapabilities, AgentSpec, type Principal } from '@hykr/contracts';
import { defineEntity, deny, type EntityPlugin } from '@hykr/core';
import { agents } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import { eq, sql } from 'drizzle-orm';
import { anyRole } from '../memory/access.js';
import { isAgentRun } from './scope.js';

/** The person's own account id (a contact has none). */
export const userOf = (p: Principal) => {
  const s = subjectOf(p);
  return s?.kind === 'user' ? s.userId : undefined;
};

/** What only the owner changes: everything an agent does. A manager may change `status`. */
const OWNERS_FIELDS = ['name', 'description', 'instructions', 'triggers', 'scope', 'budget'];

/**
 * Who reaches agents: their owner, and every agent of the business with `agents.manage`. Making
 * one needs `agents.create`; only its owner changes what it does; a manager pauses, resumes and
 * deletes anyone's. An agent's own run never reaches any.
 */
export const AgentAccess: EntityPlugin = {
  name: 'agents.access',
  appliesTo: (spec) => spec === AgentSpec,
  scope(p) {
    if (isAgentRun(p)) return sql`false`;
    if (can(p, AgentCapabilities.manage)) return undefined;
    const me = userOf(p);
    return me ? eq(agents.ownerId, me) : sql`false`;
  },
  rules: [
    (p, action, row, input) => {
      if (isAgentRun(p)) return deny('agent_scope', 'An agent run cannot manage agents');
      if (action === 'create')
        return can(p, AgentCapabilities.create) && userOf(p)
          ? null
          : deny('agents_create', "You can't make agents here");
      const owner = (row as { ownerId?: unknown } | null)?.ownerId;
      const mine = owner !== undefined && owner === userOf(p);
      if (action === 'delete')
        return mine || can(p, AgentCapabilities.manage)
          ? null
          : deny('agent_not_yours', 'Only its owner or a manager can delete this agent');
      if (mine) return null;
      const changes = Object.entries(input ?? {}).filter(([, v]) => v !== undefined);
      const ownersOnly = changes.some(([k]) => OWNERS_FIELDS.includes(k));
      if (ownersOnly)
        return deny('agent_not_yours', 'Only the owner can change what this agent does');
      return can(p, AgentCapabilities.manage)
        ? null
        : deny('agent_not_yours', 'Only its owner or a manager can pause or resume this agent');
    },
  ],
};

/**
 * The business's agents. Every role reaches the business here; `agents.access` narrows it by
 * ownership and capability, so an application's own roles opt in by holding them.
 */
export const Agent = defineEntity(AgentSpec, {
  table: agents,
  owner: (t) => t.ownerId,
  access: { read: anyRole('tenant'), write: anyRole('tenant') },
  summarize: (action, input, row) => {
    const name = String(input?.name ?? row?.name ?? 'an agent');
    if (action === 'create') return `Create the agent "${name}"`;
    if (action === 'delete') return `Delete the agent "${name}"`;
    if (input?.status && Object.keys(input).length === 1)
      return `${input.status === 'paused' ? 'Pause' : 'Resume'} the agent "${name}"`;
    return `Change the agent "${name}"`;
  },
});
