// The outbox for screens: what is waiting on this device, and whether the device is online.
import type { WriteAction } from '@hykr/contracts';
import { onlineManager } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import type { PendingWrite } from '../../framework/write-queue';
import { theOutbox } from './runtime';

const subscribeOnline = (l: () => void) => onlineManager.subscribe(l);
const isOnline = () => onlineManager.isOnline();

/** Is the device online, as far as it knows (expo-network, the browser)? */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, isOnline);
}

const subscribeOutbox = (l: () => void) => theOutbox().subscribe(l);
const outboxItems = () => theOutbox().items();
const outboxSyncing = () => theOutbox().syncing();
const outboxPaused = () => theOutbox().paused();

/** The signed-in person's outbox: its items, whether it is sending, and what can be done. */
export function useOutbox() {
  const items = useSyncExternalStore(subscribeOutbox, outboxItems, outboxItems);
  const syncing = useSyncExternalStore(subscribeOutbox, outboxSyncing, outboxSyncing);
  const paused = useSyncExternalStore(subscribeOutbox, outboxPaused, outboxPaused);
  const online = useOnline();
  return {
    items,
    online,
    syncing,
    /** Waiting for the person to sign in again. */
    paused,
    /** Writes still to send. */
    waiting: items.filter((i) => i.state !== 'failed').length,
    /** Writes the server refused, kept for the person. */
    failed: items.filter((i) => i.state === 'failed').length,
    sync: () => theOutbox().flush(),
    retry: (id: string, opts?: { overwrite?: boolean }) => theOutbox().retry(id, opts),
    discard: (id: string) => theOutbox().discard(id),
  };
}

/**
 * The writes waiting on this device (or refused) for one entity, by its plural, and for some
 * actions only: a screen lists the records made offline that the server has not seen yet.
 */
export function usePendingWrites(
  entity?: string,
  actions?: readonly WriteAction[],
): readonly PendingWrite[] {
  const items = useSyncExternalStore(subscribeOutbox, outboxItems, outboxItems);
  const key = actions?.join(',') ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `actions`
  return useMemo(
    () =>
      items.filter(
        (i) =>
          entity === undefined ||
          (i.op.kind === 'entity' &&
            i.op.entity === entity &&
            (!actions || actions.includes(i.op.action))),
      ),
    [items, entity, key],
  );
}
