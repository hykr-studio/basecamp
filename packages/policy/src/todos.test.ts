import type { Principal } from '@app/contracts';
import { expect, it } from 'vitest';
import { authorizeTodo, type TodoAction } from './todos.js';

const user = (id: string): Principal => ({
  actor: { kind: 'user', id, role: 'owner' },
  scopes: [],
});

const agent = (userId?: string): Principal => ({
  actor: { kind: 'agent', id: 'todo-agent', role: 'agent' },
  ...(userId ? { actingFor: { userId } } : {}),
  scopes: [],
});

const alice = user('alice');
const actingForAlice = agent('alice');

it.each<{
  name: string;
  principal: Principal;
  action: TodoAction;
  resource: { ownerId: string } | null;
  decision: 'allow' | 'deny' | 'needs_approval';
  rule: string;
}>([
  {
    name: 'owner lists',
    principal: alice,
    action: 'todo.list',
    resource: null,
    decision: 'allow',
    rule: 'owner_access',
  },
  {
    name: 'owner deletes own',
    principal: alice,
    action: 'todo.delete',
    resource: { ownerId: 'alice' },
    decision: 'allow',
    rule: 'owner_access',
  },
  {
    name: "owner edits someone else's",
    principal: alice,
    action: 'todo.update',
    resource: { ownerId: 'bob' },
    decision: 'deny',
    rule: 'owner_only',
  },
  {
    name: 'agent creates for Alice',
    principal: actingForAlice,
    action: 'todo.create',
    resource: null,
    decision: 'allow',
    rule: 'owner_access',
  },
  {
    name: "agent deletes Alice's",
    principal: actingForAlice,
    action: 'todo.delete',
    resource: { ownerId: 'alice' },
    decision: 'needs_approval',
    rule: 'agent_delete_needs_approval',
  },
  {
    name: "agent touches Bob's while acting for Alice",
    principal: actingForAlice,
    action: 'todo.update',
    resource: { ownerId: 'bob' },
    decision: 'deny',
    rule: 'owner_only',
  },
  {
    name: 'agent with nobody to act for',
    principal: agent(),
    action: 'todo.create',
    resource: null,
    decision: 'deny',
    rule: 'agent_needs_acting_for',
  },
])('$name', ({ principal, action, resource, decision, rule }) => {
  expect(authorizeTodo(principal, action, resource)).toMatchObject({ decision, rule });
});
