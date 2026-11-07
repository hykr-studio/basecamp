// Is the device online? The web: the browser's own flag and its online/offline events. iOS and
// Android use network.native.ts (expo-network). A request that fails for want of a network tells
// the outbox too, whatever these say.

/** Watch the network: `set(online)` now and on every change. Returns the cleanup. */
export function watchNetwork(set: (online: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return () => {};
  const on = () => set(true);
  const off = () => set(false);
  set(navigator.onLine !== false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}
