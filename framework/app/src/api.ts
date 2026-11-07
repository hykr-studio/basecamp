import { createApiClient } from '@hykr/api-client';
import { appConfig } from './config';
import { businessHeaders } from './framework/business';
import { credentials, authHeaders as sessionHeaders } from './session';

export { auth, credentials, type SessionUser } from './session';

/**
 * What every call to the API carries: how the person proves who they are (session.ts on the
 * web: nothing, the browser sends the cookie; session.native.ts on iOS and Android: the cookie
 * from SecureStore), and the business they chose to work in (`x-tenant-id`, the switcher's).
 */
export async function authHeaders(): Promise<Record<string, string>> {
  return { ...(await sessionHeaders()), ...businessHeaders() };
}

/**
 * The app's one API client. Screens, views and the chat never know which platform they run on
 * or which business they are in: both are in its headers. The address is read per request, so
 * configure() may run after this module loads.
 */
export const api = createApiClient({
  get baseUrl() {
    return appConfig().apiUrl;
  },
  credentials,
  headers: authHeaders,
});
