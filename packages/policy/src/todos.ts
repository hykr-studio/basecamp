import type { AuthorizeResult, Principal } from '@app/contracts';

export type TodoAction = 'todo.list' | 'todo.create' | 'todo.update' | 'todo.delete';

/** The person an action is for: yourself, or the person the agent acts for. */
export function subjectOf(p: Principal): string | null {
  return p.actor.kind === 'user' ? p.actor.id : (p.actingFor?.userId ?? null);
}

export function authorizeTodo(
  p: Principal,
  action: TodoAction,
  resource: { ownerId: string } | null,
): AuthorizeResult {
  const subject = subjectOf(p);
  if (!subject)
    return {
      decision: 'deny',
      rule: 'agent_needs_acting_for',
      reason: 'Agent calls must name a person',
    };
  if (resource && resource.ownerId !== subject)
    return { decision: 'deny', rule: 'owner_only', reason: 'You can only change your own to-dos' };
  if (p.actor.kind === 'agent' && action === 'todo.delete')
    return {
      decision: 'needs_approval',
      rule: 'agent_delete_needs_approval',
      reason: 'You need to approve this delete',
    };
  return { decision: 'allow', rule: 'owner_access', reason: 'Owner works on their own to-dos' };
}
