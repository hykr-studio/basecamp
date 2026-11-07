// What a live event means for the app's cached data: pure, so it is tested without React Native.
import type { LiveEvent } from '@hykr/contracts';

/** What of the catalog the keys depend on: entities' names and plurals, commands' touches. */
export type LiveCatalog = {
  entities: Readonly<Record<string, { name: string; plural: string }>>;
  commands: readonly { name: string; touches?: readonly string[] }[];
};

const CRUD = /\.(created|updated|deleted)$/;

/**
 * The query keys a live event invalidates. An approval: the approvals list and that approval.
 * A job: every jobs query (`useJob`, `useJobs`). A comment: comment lists and history (its
 * record's history shows it). An inbox item: the inbox. An agent's run: the run logs. An entity's record: its plural (lists and
 * records) and history; an event that is not a create, update or delete (a command's) also what
 * the type's commands say they touch. Anything else: nothing.
 */
export function liveKeysFor(event: LiveEvent, catalog: LiveCatalog): string[][] {
  if (event.type === 'approval') return [['approvals'], ['approval', event.id]];
  if (event.type === 'job') return [['jobs']];
  if (event.type === 'comment') return [['comments'], ['history']];
  if (event.type === 'inbox') return [['inbox']];
  // An agent's run (A6): the run logs, and that run.
  if (event.type === 'agent_run') return [['agent-runs'], ['agent-run', event.id]];
  const specs = Object.values(catalog.entities);
  const pluralOf = (name: string) => specs.find((s) => s.name === name)?.plural;
  const own = pluralOf(event.type);
  if (!own) return [];
  const plurals = new Set([own]);
  if (!CRUD.test(event.name))
    for (const command of catalog.commands) {
      if (!command.name.startsWith(`${event.type}.`)) continue;
      for (const name of command.touches ?? specs.map((s) => s.name)) {
        const plural = pluralOf(name);
        if (plural) plurals.add(plural);
      }
    }
  return [...[...plurals].map((p) => [p]), ['history']];
}

/**
 * Collects keys for `waitMs`, then invalidates each once: a burst of events (a command that
 * writes ten rows) refetches each list once.
 */
export function createInvalidator(
  invalidate: (key: string[]) => void,
  waitMs = 250,
): { add(keys: readonly string[][]): void; flush(): void; cancel(): void } {
  const pending = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const keys = [...pending.values()];
    pending.clear();
    for (const key of keys) invalidate(key);
  };
  return {
    add(keys) {
      for (const key of keys) pending.set(JSON.stringify(key), key);
      if (pending.size && !timer) timer = setTimeout(flush, waitMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

/** How long to wait before reconnecting, after this many failed tries in a row: 1 s to 30 s. */
export const reconnectDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);
