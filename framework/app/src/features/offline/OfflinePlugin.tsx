import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { touchedBy } from '../../chat/touched';
import type { AppPlugin } from '../../framework/app-domain';
import { currentBusiness, onBusinessChange } from '../../framework/business';
import { useT } from '../../framework/lang';
import { useToast } from '../../framework/Toast';
import { setWriteQueue } from '../../framework/write-queue';
import { getCatalog } from '../../runtime';
import type { SessionUser } from '../../session';
import { forgetCache, persistCache } from './cache';
import { watchNetwork } from './network';
import { OfflineScreen } from './OfflineScreen';
import type { Settled } from './outbox';
import { OfflineBanner } from './PendingWrites';
import { theOutbox } from './runtime';
import { deviceStore } from './store';

export type OfflineOptions = {
  /** How long answers kept on the device are shown (default 7 days). */
  maxAgeMs?: number;
  /** Change it when a release changes what screens expect: kept answers are then dropped. */
  cacheVersion?: string;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Who is signed in, as the plugin's sign-in effect tells its provider. */
let signedIn: SessionUser | null = null;
const listeners = new Set<() => void>();
const setSignedIn = (user: SessionUser | null) => {
  signedIn = user;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const current = () => signedIn;

/** The network's state into React Query (queries pause offline), and the outbox sent on return. */
let networkWired = false;
function wireNetwork() {
  if (networkWired) return;
  networkWired = true;
  onlineManager.setEventListener((setOnline) => watchNetwork(setOnline));
  onlineManager.subscribe((online) => {
    if (online) void theOutbox().flush();
  });
}

/** The query keys a synced write may have changed: its entity's, or what its command touches. */
function keysOf(s: Settled): string[] {
  const { op } = s.item;
  if (op.kind === 'entity') return [op.entity];
  const spec = getCatalog().commandByName(op.command);
  return spec?.tool ? touchedBy(spec.tool) : Object.keys(getCatalog().entities);
}

function OfflineProvider({ children, options }: { children: ReactNode; options: OfflineOptions }) {
  const client = useQueryClient();
  const toast = useToast();
  const { t } = useT();
  const user = useSyncExternalStore(subscribe, current, current);
  const business = useSyncExternalStore(onBusinessChange, currentBusiness, currentBusiness);
  useEffect(wireNetwork, []);

  // What a person read, kept on this device for them in this business.
  useEffect(() => {
    if (!user) return;
    let stop: (() => void) | undefined;
    let stopped = false;
    void deviceStore().then((store) => {
      if (stopped) return;
      stop = persistCache(
        client,
        store.kv,
        { userId: user.id, business },
        { maxAgeMs: options.maxAgeMs ?? WEEK_MS, buster: options.cacheVersion ?? '1' },
      );
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [user, business, client, options.maxAgeMs, options.cacheVersion]);

  // A synced write refreshes what it changed; one the person is no longer waiting for is told.
  useEffect(
    () =>
      theOutbox().onSettled((s) => {
        void Promise.all(
          [...keysOf(s), 'approvals', 'history'].map((k) =>
            client.invalidateQueries({ queryKey: [k] }),
          ),
        );
        if (s.attached) return;
        if (s.outcome === 'parked' && s.result.status === 'needs_approval')
          toast.show({
            message: t('offline.parked', { summary: s.result.approval.summary ?? '' }),
          });
        if (s.outcome === 'failed')
          toast.show({
            tone: 'error',
            message: t('offline.failed', { reason: s.error.message }),
            action: { label: t('offline.review'), onPress: () => router.navigate('/offline') },
          });
      }),
    [client, toast, t],
  );
  return children;
}

/**
 * Offline capture (decisions B12): writes on entities and commands their modules mark `offline`
 * are kept on the device (SQLite on a phone, IndexedDB in a browser) and sent in order with the
 * idempotency key they were given, now or when the network is back; what a person read is kept
 * too, so screens show it offline. A strip above the screen says when the device is offline or
 * changes are waiting, and `/offline` lists them, with the server's reason for any it refused.
 * List it in `<AppShell plugins>`; signing out forgets the kept answers, not unsynced changes.
 */
export function offlinePlugin(options: OfflineOptions = {}): AppPlugin {
  const Provider = ({ children }: { children: ReactNode }) => (
    <OfflineProvider options={options}>{children}</OfflineProvider>
  );
  return {
    name: 'offline',
    Provider,
    Banner: OfflineBanner,
    routes: [{ path: '/offline', screen: OfflineScreen }],
    onSignedIn: (user) => {
      setSignedIn(user);
      const outbox = theOutbox();
      setWriteQueue(outbox);
      void outbox.start(user.id).catch((e) => console.warn('The outbox could not start', e));
      return () => {
        setWriteQueue(undefined);
        outbox.stop();
        setSignedIn(null);
      };
    },
    onSignOut: async (user) => {
      const store = await deviceStore();
      await forgetCache(store.kv, user.id);
    },
  };
}
