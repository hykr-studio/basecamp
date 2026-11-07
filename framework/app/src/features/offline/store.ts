// The device's offline store on the web: IndexedDB, one database with the outbox and a small
// key-value table (the persisted query cache). A browser that keeps nothing (a private window,
// storage blocked) gets memory instead: the app works, and forgets on reload. iOS and Android use
// store.native.ts (SQLite), with the same export.
import type { PendingWrite } from '../../framework/write-queue';
import { type DeviceStore, type KeyValue, memoryDeviceStore } from './device';
import type { OutboxStore } from './outbox';

const DB = 'basecamp-offline';
const OUTBOX = 'outbox';
const KV = 'kv';

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const r = factory.open(DB, 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains(OUTBOX)) {
      const store = db.createObjectStore(OUTBOX, { keyPath: 'id' });
      store.createIndex('userId', 'userId');
    }
    if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
  };
  return request(r);
}

/** The outbox and key-value store over one IndexedDB database. */
export function indexedDbStore(db: IDBDatabase): DeviceStore {
  const write = async (name: string, fn: (s: IDBObjectStore) => void) => {
    const tx = db.transaction(name, 'readwrite');
    fn(tx.objectStore(name));
    await done(tx);
  };
  const outbox: OutboxStore = {
    async load(userId) {
      const tx = db.transaction(OUTBOX, 'readonly');
      const rows = await request(
        tx.objectStore(OUTBOX).index('userId').getAll(IDBKeyRange.only(userId)),
      );
      return (rows as PendingWrite[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    put: (item) => write(OUTBOX, (s) => s.put(item)),
    remove: (id) => write(OUTBOX, (s) => s.delete(id)),
  };
  const kv: KeyValue = {
    async getItem(key) {
      const tx = db.transaction(KV, 'readonly');
      const value = await request(tx.objectStore(KV).get(key));
      return typeof value === 'string' ? value : null;
    },
    setItem: (key, value) => write(KV, (s) => s.put(value, key)),
    removeItem: (key) => write(KV, (s) => s.delete(key)),
  };
  return { outbox, kv, durable: true };
}

let opened: Promise<DeviceStore> | undefined;

/** This device's store, opened once. */
export function deviceStore(): Promise<DeviceStore> {
  opened ??= (async () => {
    try {
      const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!factory) return memoryDeviceStore();
      return indexedDbStore(await open(factory));
    } catch (e) {
      console.warn('Offline storage is not available here; writes are kept for this page only', e);
      return memoryDeviceStore();
    }
  })();
  return opened;
}
