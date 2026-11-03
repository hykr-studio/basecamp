import { createApiClient } from '@hykr/api-client';
import { appConfig } from './config';
import { authHeaders, credentials } from './session';

export { auth, authHeaders, credentials, type SessionUser } from './session';

/**
 * The app's one API client. How a request proves who the person is lives in session.ts
 * (web: the browser's cookie) and session.native.ts (iOS, Android: the cookie from
 * SecureStore), so screens, views and the chat never know which platform they run on.
 * The address is read per request, so configure() may run after this module loads.
 */
export const api = createApiClient({
  get baseUrl() {
    return appConfig().apiUrl;
  },
  credentials,
  headers: authHeaders,
});
