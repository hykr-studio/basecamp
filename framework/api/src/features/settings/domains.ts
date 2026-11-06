// Custom domains (A11, white label): a business's own web addresses, trusted for CORS and sign-in
// only after it proves it controls them with a DNS TXT record. One origin belongs to one business.
import { resolveTxt } from 'node:dns/promises';
import { schema } from '@hykr/db';
import type { BetterAuthPlugin } from 'better-auth';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AuthPlugin } from '../../hooks.js';

/** Looks up a host's TXT records: DNS, or a test's fake. */
export type TxtResolver = (name: string) => Promise<string[][]>;

let txt: TxtResolver = resolveTxt;

/** Use another TXT lookup (tests). */
export function setTxtResolver(fn: TxtResolver | undefined) {
  txt = fn ?? resolveTxt;
}

/** Do the host's TXT records hold this token? A lookup that fails says no. */
export async function txtHolds(name: string, token: string): Promise<boolean> {
  try {
    return (await txt(name)).some((chunks) => chunks.join('') === token);
  } catch {
    return false;
  }
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; tenantId: string | null }>();

/** The business a verified origin belongs to, or null. Cached for 30 seconds per process. */
export async function verifiedTenantOf(origin: string): Promise<string | null> {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tenantId;
  const d = schema.tenantDomains;
  // Loaded when first asked: @hykr/api reads no configuration when it loads.
  const { sharedDb } = await import('../../infra/db.js');
  const [row] = await sharedDb.db
    .select({ tenantId: d.tenantId })
    .from(d)
    .where(and(eq(d.origin, origin), isNotNull(d.verifiedAt)))
    .limit(1);
  const tenantId = row?.tenantId ?? null;
  cache.set(origin, { at: Date.now(), tenantId });
  return tenantId;
}

/** Forget what this process knows of an origin (after it is verified or removed). */
export function forgetOrigin(origin?: string) {
  if (origin === undefined) cache.clear();
  else cache.delete(origin);
}

/** Is this a business's verified origin? Only exact https origins ever are. */
export async function originAllowed(origin: string): Promise<boolean> {
  if (!/^https:\/\/[^/]+$/.test(origin)) return false;
  return (await verifiedTenantOf(origin)) !== null;
}

/**
 * Better Auth trusts a request's Origin when it is a verified custom domain, besides the static
 * list: a plugin's `trustedOrigins` function is asked per request (Better Auth 1.7.7).
 */
const customDomainsPlugin = (): BetterAuthPlugin => ({
  id: 'custom-domains',
  init: () => ({
    options: {
      trustedOrigins: async (request?: Request) => {
        const origin = request?.headers.get('origin');
        return origin && (await originAllowed(origin)) ? [origin] : [];
      },
    },
  }),
});

/** Sign-in and CORS for verified custom domains. */
export const customDomainsAuth: AuthPlugin = {
  name: 'custom-domains',
  plugin: customDomainsPlugin(),
  originAllowed,
};
