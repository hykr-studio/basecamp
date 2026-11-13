// What the device keeps for offline work, on every platform: the outbox and a small key-value
// store (the persisted query cache). store.ts opens it on the web (IndexedDB), store.native.ts on
// iOS and Android (SQLite); memory is the fallback when nothing can be kept.
import { memoryStore, type OutboxStore } from './outbox';

/** What the query-cache persister needs: an async string store. */
export interface KeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DeviceStore {
  outbox: OutboxStore;
  kv: KeyValue;
  /** False when nothing outlives the app (memory). */
  durable: boolean;
}

/** Everything in memory, for as long as the app runs. */
export function memoryDeviceStore(): DeviceStore {
  const values = new Map<string, string>();
  return {
    outbox: memoryStore(),
    kv: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
    durable: false,
  };
}
