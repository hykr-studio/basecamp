import { MemoryManage, MemoryRead, MemorySpec, MemoryWrite, type Principal } from '@hykr/contracts';
import { deny, type EntityPlugin } from '@hykr/core';
import { memories } from '@hykr/db';
import { type AccessRule, can, type RoleAccess, subjectOf } from '@hykr/policy';
import { eq, sql } from 'drizzle-orm';

/**
 * The same rule for every role, the application's own included: an entity whose reach is decided
 * by capabilities, not by role names. A plugin then narrows it (scope and rules); alone it grants
 * the whole business.
 */
export function anyRole(rule: AccessRule): RoleAccess {
  const isRole = (key: string | symbol): key is string => typeof key === 'string';
  return new Proxy({} as Record<string, AccessRule>, {
    get: (_target, key) => (isRole(key) ? rule : undefined),
    has: (_target, key) => isRole(key),
    getOwnPropertyDescriptor: (_target, key) =>
      isRole(key)
        ? { value: rule, writable: false, enumerable: true, configurable: true }
        : undefined,
  });
}

/** The person's own account id, when they have one (a contact has none). */
const userOf = (p: Principal) => {
  const s = subjectOf(p);
  return s?.kind === 'user' ? s.userId : undefined;
};

/** May change or delete this memory: anyone's with `memory.manage`, their own with `memory.write`. */
const mayChange = (p: Principal, ownerId: unknown) =>
  can(p, MemoryManage) || (can(p, MemoryWrite) && ownerId !== undefined && ownerId === userOf(p));

/**
 * Who reaches the business's memory, by capability: `memory.read` reads all of it (nothing
 * without), `memory.write` adds memory and changes or deletes the person's own, `memory.manage`
 * anyone's. Scope narrows every query; the rules give a refusal its reason.
 */
export const MemoryAccess: EntityPlugin = {
  name: 'memory.access',
  appliesTo: (spec) => spec === MemorySpec,
  scope(p, op) {
    if (op === 'read') return can(p, MemoryRead) ? undefined : sql`false`;
    if (can(p, MemoryManage)) return undefined;
    const me = userOf(p);
    return can(p, MemoryWrite) && me ? eq(memories.ownerId, me) : sql`false`;
  },
  rules: [
    (p, action, row) => {
      if (action === 'create')
        return can(p, MemoryWrite)
          ? null
          : deny('memory_write', "You can't add to the business's memory");
      return mayChange(p, (row as { ownerId?: unknown } | null)?.ownerId)
        ? null
        : deny(
            'memory_not_yours',
            'Only the person who wrote this memory, or a manager, can change it',
          );
    },
  ],
};
