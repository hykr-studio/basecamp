import { authPlugins } from '../hooks.js';
import { corsOrigins } from './auth.js';

type Callback = (err: Error | null, allow?: boolean) => void;

/**
 * CORS's origin check: the static web origins (WEB_ORIGINS and the auth plugins'), then each auth
 * plugin's `originAllowed` (a business's verified custom domain). No Origin: no CORS headers.
 */
export function corsOrigin() {
  const fixed = new Set(corsOrigins());
  return (origin: string | undefined, callback: Callback) => {
    if (!origin) return callback(null, false);
    if (fixed.has(origin)) return callback(null, true);
    const asks = authPlugins.all().flatMap((p) => (p.originAllowed ? [p.originAllowed] : []));
    Promise.all(asks.map((ask) => ask(origin).catch(() => false)))
      .then((answers) => callback(null, answers.some(Boolean)))
      .catch(() => callback(null, false));
  };
}
