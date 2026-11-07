import { storage } from './storage';

/**
 * The business a person chose to work in on this device (the switcher), sent as `x-tenant-id`
 * on every API and chat call. None chosen: the server's default for them. Read when the app
 * starts, so the first call already carries it; kept with whose choice it is, so another person
 * signing in on the device starts from their own default.
 */
const KEY = 'basecamp.business';

type Choice = { userId: string; tenantId: string };

function read(): Choice | null {
  try {
    const raw = storage.get(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<Choice>) : null;
    return value?.userId && value.tenantId
      ? { userId: value.userId, tenantId: value.tenantId }
      : null;
  } catch {
    return null;
  }
}

let chosen: Choice | null = read();
let person: string | null = chosen?.userId ?? null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** The signed-in person: a choice another person made on this device no longer applies. */
export function businessOf(userId: string) {
  person = userId;
  if (chosen && chosen.userId !== userId) {
    chosen = null;
    storage.remove(KEY);
    changed();
  }
}

/** Work in this business from now on (null: the server's default). */
export function chooseBusiness(tenantId: string | null) {
  if (!person || (chosen?.tenantId ?? null) === tenantId) return;
  chosen = tenantId ? { userId: person, tenantId } : null;
  if (chosen) storage.set(KEY, JSON.stringify(chosen));
  else storage.remove(KEY);
  changed();
}

/** The business chosen on this device, if any. */
export const currentBusiness = (): string | null => chosen?.tenantId ?? null;

/** What a call carries for it. */
export const businessHeaders = (): Record<string, string> =>
  chosen ? { 'x-tenant-id': chosen.tenantId } : {};

/** Called when the choice changes (for useSyncExternalStore). */
export function onBusinessChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
