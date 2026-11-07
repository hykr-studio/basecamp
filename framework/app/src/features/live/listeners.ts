// Who else hears the live stream's events, besides React Query's invalidation: the assistant's
// chat runtime reloads its thread when a run went on in it (durable runs). Pure: no React Native.
import type { LiveEvent } from '@hykr/contracts';

type Listener = (event: LiveEvent) => void;
const listeners = new Set<Listener>();

/** Hear every live event while the stream is open. Returns the unsubscribe. */
export function onLiveEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every listener; one that throws does not stop the others. */
export function emitLiveEvent(event: LiveEvent) {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A listener's failure is its own.
    }
  }
}
