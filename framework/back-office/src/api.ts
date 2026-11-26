import { ApiError, createApiClient } from '@hykr/api-client';
import { backOfficeConfig } from './config';

/**
 * The business the back office works in when it names one: an operator's support access to it
 * (B19). Null: the person's own default business.
 */
let workingIn: string | null = null;

/** Work in this business (sent as `x-tenant-id` on every call), or back in one's own (null). */
export function workIn(tenantId: string | null) {
  workingIn = tenantId;
}
export const workingInBusiness = () => workingIn;

/**
 * The back office is a client like the app: the typed API client, with the browser's session
 * cookie. Nothing here reaches past the API.
 */
export const api = createApiClient({
  // Read per request, so configure() may run after this module loads.
  get baseUrl() {
    return backOfficeConfig().apiUrl;
  },
  credentials: 'include',
  headers: (): Record<string, string> => (workingIn ? { 'x-tenant-id': workingIn } : {}),
});

export type SessionUser = { id: string; name: string; email: string };

async function authCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${backOfficeConfig().apiUrl}/api/auth${path}`, {
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
