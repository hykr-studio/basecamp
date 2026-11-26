// Is the device online, on iOS and Android: expo-network's state, now and on every change. A
// network that is connected but cannot reach the internet counts as offline. Same export as
// network.ts (the web's).
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';

const isOnline = (s: NetworkState) => s.isConnected !== false && s.isInternetReachable !== false;

/** Watch the network: `set(online)` now and on every change. Returns the cleanup. */
export function watchNetwork(set: (online: boolean) => void): () => void {
  let stopped = false;
  getNetworkStateAsync()
    .then((s) => {
      if (!stopped) set(isOnline(s));
    })
    .catch(() => {});
  const sub = addNetworkStateListener((s) => set(isOnline(s)));
  return () => {
    stopped = true;
    sub.remove();
  };
}
