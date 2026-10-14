import type { BetterAuthPlugin } from 'better-auth';

/**
 * The native apps' origin, for Better Auth's origin check. iOS and Android cannot set an
 * Origin header, so the app's auth client (Better Auth's Expo client) sends its scheme as
 * `expo-origin` instead; this copies it into `origin`, which is then checked against
 * trustedOrigins like any browser's. (The server half of @better-auth/expo, minus its
 * social-login proxy, which this template does not use; importing that package would pull
 * the Expo client packages into the API.)
 */
export const nativeAppOrigin = (): BetterAuthPlugin => ({
  id: 'native-app-origin',
  async onRequest(request) {
    if (request.headers.get('origin')) return;
    const appOrigin = request.headers.get('expo-origin');
    if (!appOrigin) return;
    const headers = new Headers(request.headers);
    headers.set('origin', appOrigin);
    return { request: new Request(request, { headers }) };
  },
});
