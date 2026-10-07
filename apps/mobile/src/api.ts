import { ApiError, createApiClient } from '@app/api-client';
import { API_URL } from './config';

/** The browser sends the session cookie with every call: same site, so credentials: 'include' is enough. */
export const api = createApiClient({ baseUrl: API_URL, credentials: 'include' });

export type SessionUser = { id: string; name: string; email: string };

async function authCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

/** Better Auth's own routes, called directly: they are not part of the to-do API. */
export const auth = {
  async me() {
    const session = await authCall<{ user: SessionUser } | null>('/get-session');
    return session?.user ?? null;
  },
  async signIn(email: string, password: string) {
    const r = await authCall<{ user: SessionUser }>('/sign-in/email', { email, password });
    return r.user;
  },
  async signUp(name: string, email: string, password: string) {
    const r = await authCall<{ user: SessionUser }>('/sign-up/email', { name, email, password });
    return r.user;
  },
  signOut: () => authCall<unknown>('/sign-out', {}),
};
