import { ApiError, createApiClient } from '@app/api-client';
import { API_URL } from './config';

/**
 * The back office is a client like the app: the typed API client, with the browser's session
 * cookie. Nothing here reaches past the API.
 */
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

/** Better Auth's routes: the same accounts as the app. */
export const auth = {
  async me() {
    const session = await authCall<{ user: SessionUser } | null>('/get-session');
    return session?.user ?? null;
  },
  async signIn(email: string, password: string) {
    return (await authCall<{ user: SessionUser }>('/sign-in/email', { email, password })).user;
  },
  signOut: () => authCall<unknown>('/sign-out', {}),
};

/** What a refusal says, for a person. */
export function reasonOf(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { reason?: string; message?: unknown } | null;
    if (body?.reason) return body.reason;
    if (typeof body?.message === 'string') return body.message;
    return `The server said ${e.status}`;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}
