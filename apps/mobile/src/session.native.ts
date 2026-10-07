import { ApiError } from '@app/api-client';
import { expoClient } from '@better-auth/expo/client';
import { createAuthClient } from 'better-auth/client';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

/**
 * iOS and Android: no browser cookie jar. Better Auth's Expo plugin keeps the session in
 * SecureStore (so it survives an app restart), and every request carries it as a Cookie
 * header. Same exports as session.ts; Metro picks this file on native.
 */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  plugins: [
    expoClient({ scheme: 'agenticstack', storagePrefix: 'agenticstack', storage: SecureStore }),
  ],
});

export const credentials: 'include' | 'omit' = 'omit';
export async function authHeaders(): Promise<Record<string, string>> {
  const cookie = await authClient.getCookie();
  return cookie ? { Cookie: cookie } : {};
}

export type SessionUser = { id: string; name: string; email: string };

/** Better Auth's client returns { data, error }: turn an error into the app's ApiError. */
function unwrap<T>(r: { data: T | null; error: { status: number; message?: string } | null }): T {
  if (r.error) throw new ApiError(r.error.status, { message: r.error.message });
  return r.data as T;
}

export const auth = {
  async me() {
    const r = await authClient.getSession();
    return (r.data?.user as SessionUser | undefined) ?? null;
  },
  async signIn(email: string, password: string) {
    return unwrap(await authClient.signIn.email({ email, password })).user as SessionUser;
  },
  async signUp(name: string, email: string, password: string) {
    return unwrap(await authClient.signUp.email({ name, email, password })).user as SessionUser;
  },
  signOut: () => authClient.signOut(),
};
