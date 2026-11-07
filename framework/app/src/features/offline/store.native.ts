// The device's offline store on iOS and Android: one SQLite database with the outbox and a small
// key-value table (the persisted query cache). Same export as store.ts (the web's IndexedDB).
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { PendingWrite } from '../../framework/write-queue';
import { type DeviceStore, type KeyValue, memoryDeviceStore } from './device';
import type { OutboxStore } from './outbox';

const SCHEMA = `
  create table if not exists outbox (
    id text primary key not null,
    user_id text not null,
    created_at text not null,
    body text not null
  );
  create index if not exists outbox_user_idx on outbox (user_id, created_at);
  create table if not exists kv (key text primary key not null, value text not null);
`;

/** The outbox and key-value store over one SQLite database. */
export function sqliteStore(db: SQLiteDatabase): DeviceStore {
  const outbox: OutboxStore = {
    async load(userId) {
      const rows = await db.getAllAsync<{ body: string }>(
        'select body from outbox where user_id = ? order by created_at',
        userId,
      );
      return rows.map((r) => JSON.parse(r.body) as PendingWrite);
    },
    async put(item) {
      await db.runAsync(
        'insert or replace into outbox (id, user_id, created_at, body) values (?, ?, ?, ?)',
        item.id,
        item.userId,
        item.createdAt,
        JSON.stringify(item),
      );
    },
    async remove(id) {
      await db.runAsync('delete from outbox where id = ?', id);
    },
  };
  const kv: KeyValue = {
    async getItem(key) {
      const row = await db.getFirstAsync<{ value: string }>(
        'select value from kv where key = ?',
        key,
      );
      return row?.value ?? null;
    },
    async setItem(key, value) {
      await db.runAsync('insert or replace into kv (key, value) values (?, ?)', key, value);
    },
    async removeItem(key) {
      await db.runAsync('delete from kv where key = ?', key);
    },
  };
  return { outbox, kv, durable: true };
}

let opened: Promise<DeviceStore> | undefined;

/** This device's store, opened once. */
export function deviceStore(): Promise<DeviceStore> {
  opened ??= (async () => {
    try {
      const db = await openDatabaseAsync('basecamp-offline.db');
      await db.execAsync(SCHEMA);
      return sqliteStore(db);
    } catch (e) {
      console.warn('Offline storage could not be opened; writes are kept until the app closes', e);
      return memoryDeviceStore();
    }
  })();
  return opened;
}
