/** Small per-device persistence. Web: localStorage. Native: memory for this run (add AsyncStorage when shipping native). */
const memory = new Map<string, string>();

export const storage = {
  get(key: string): string | null {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
    } catch {}
    return memory.get(key) ?? null;
  },
  set(key: string, value: string) {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.setItem(key, value);
    } catch {}
    memory.set(key, value);
  },
  remove(key: string) {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.removeItem(key);
    } catch {}
    memory.delete(key);
  },
};
