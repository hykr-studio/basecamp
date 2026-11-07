import { createShareClient, type ShareClient } from '@hykr/api-client';
import { appConfig } from '../../config';
import { storage } from '../../framework/storage';

/** Where a gated link's session is kept on this device (one per link). */
const sessionKey = (token: string) => `share.session.${token}`;

/** A guest's calls through one link, carrying the session its code opened on this device. */
export function shareClientFor(token: string): ShareClient {
  return createShareClient({
    baseUrl: appConfig().apiUrl,
    token,
    session: () => storage.get(sessionKey(token)),
  });
}

/** Keep the session a right code opened, for this link on this device. */
export const keepShareSession = (token: string, session: string) =>
  storage.set(sessionKey(token), session);

/** Forget it (the server no longer takes it). */
export const dropShareSession = (token: string) => storage.remove(sessionKey(token));

/** Where a link opens in this app: '/share/:token'. */
export const SHARE_ROUTE = '/share/:token';
