import { createApiClient } from '@app/api-client';
import { API_URL } from './config';
import { authHeaders, credentials } from './session';

export { auth, authHeaders, credentials, type SessionUser } from './session';

/**
 * The app's one API client. How a request proves who the person is lives in session.ts
 * (web: the browser's cookie) and session.native.ts (iOS, Android: the cookie from
 * SecureStore), so screens, views and the chat never know which platform they run on.
 */
export const api = createApiClient({ baseUrl: API_URL, credentials, headers: authHeaders });
