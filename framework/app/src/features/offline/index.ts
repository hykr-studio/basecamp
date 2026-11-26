// Offline capture in the app (B12): the plugin, the outbox's hooks and screens, and the engine
// under them (pure, tested without React Native).
export { cacheKey } from './cache';
export { useOnline, useOutbox, usePendingWrites } from './hooks';
export { type OfflineOptions, offlinePlugin } from './OfflinePlugin';
export { OfflineScreen } from './OfflineScreen';
export {
  backoffMs,
  createOutbox,
  dispositionOf,
  MAX_ATTEMPTS,
  memoryStore,
  type Outbox,
  type OutboxDeps,
  type OutboxStore,
  type Settled,
} from './outbox';
export { OfflineBanner, PendingWriteRow, PendingWrites, pendingLabel } from './PendingWrites';
