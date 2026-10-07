import type { Principal } from '@app/contracts';

/** The person an action is for: yourself, or the person the agent acts for. */
export function subjectOf(p: Principal): string | null {
  return p.actor.kind === 'user' ? p.actor.id : (p.actingFor?.userId ?? null);
}
