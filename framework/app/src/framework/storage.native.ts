import Storage from 'expo-sqlite/kv-store';

/**
 * Small per-device persistence on iOS and Android: Expo's SQLite key-value store, which
 * survives an app restart and has a synchronous API (the same as localStorage on the web).
 */
export const storage = {
  get(key: string): string | null {
    try {
      return Storage.getItemSync(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      Storage.setItemSync(key, value);
    } catch {}
  },
  remove(key: string) {
    try {
      Storage.removeItemSync(key);
    } catch {}
  },
};
