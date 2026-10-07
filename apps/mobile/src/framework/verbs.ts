import { commandByName } from '@app/contracts';

export type Verb = { do: string; did: string };

const ENTITY_ACTIONS: Record<string, Verb> = {
  create: { do: 'create', did: 'created' },
  update: { do: 'change', did: 'changed' },
  delete: { do: 'delete', did: 'deleted' },
};

/**
 * How people say an audited action ('todo.update', 'meeting.close'): a command's own verb
 * from its spec, or the entity action's. The framework never lists a domain's verbs.
 */
export function verbOf(action: string): Verb & { entityAction: boolean } {
  const command = commandByName(action);
  if (command) {
    const fallback = action.split('.').pop() ?? action;
    return { ...(command.verb ?? { do: fallback, did: `${fallback}d` }), entityAction: false };
  }
  const last = action.split('.').pop() ?? '';
  return { ...(ENTITY_ACTIONS[last] ?? { do: last, did: last }), entityAction: true };
}
