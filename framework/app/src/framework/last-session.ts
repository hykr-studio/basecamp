// The last person signed in on this device (B12): when the session cannot be checked for want of
// a network, the shell opens on them instead of the sign-in screen, and checks again once the
// network is back. Only who they are (id, name, email); the API still checks every request.
import type { SessionUser } from '../session';
import { storage } from './storage';

const KEY = 'basecamp.last-session';

/** Remember who is signed in. */
export function rememberSession(user: SessionUser) {
  storage.set(KEY, JSON.stringify({ id: user.id, name: user.name, email: user.email }));
}

/** Who was signed in last, if anyone. */
export function lastSession(): SessionUser | null {
  try {
    const raw = storage.get(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<SessionUser>) : null;
    return value?.id && typeof value.name === 'string' && typeof value.email === 'string'
      ? { id: value.id, name: value.name, email: value.email }
      : null;
  } catch {
    return null;
  }
}

/** Forget them (sign-out, a refused session). */
export function forgetSession() {
  storage.remove(KEY);
}
