// Custom domains (A11, white label): a business's own web addresses, trusted for CORS and sign-in
// only after it proves it controls them with a DNS TXT record. One origin belongs to one business.
import { resolveTxt } from 'node:dns/promises';
import { DomainOrigin } from '@hykr/contracts';
import { schema } from '@hykr/db';
import type { BetterAuthPlugin } from 'better-auth';
import { isNotNull } from 'drizzle-orm';
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

/** Could this be a business's address? Only an exact https origin of at most 200 characters. */
export const isDomainOrigin = (origin: string) => DomainOrigin.safeParse(origin).success;

/** Every verified origin and its business: what one lookup of the whole set returns. */
export type VerifiedOrigins = ReadonlyMap<string, string>;

/**
 * Which business a verified origin belongs to, from a copy of every verified origin held for
 * `ttlMs`. Anyone can ask (CORS preflights and the public branding need no session), so a
 * question costs no query and keeps nothing: one load of the set serves every origin, concurrent
 * askers share one load, and an origin that is not an https origin is never looked up. The copy
 * grows only with verified domains, which a business must prove with DNS.
 */
export function originLookup(load: () => Promise<VerifiedOrigins>, ttlMs = 30_000) {
  let copy: { at: number; origins: VerifiedOrigins } | null = null;
  let loading: Promise<VerifiedOrigins> | null = null;
  // Bumped by forget(): a load that started before it does not become the copy.
  let generation = 0;

  const fresh = (): Promise<VerifiedOrigins> => {
    if (copy && Date.now() - copy.at < ttlMs) return Promise.resolve(copy.origins);
    if (loading) return loading;
    const started = generation;
    const pending = load().then((origins) => {
      if (started === generation) copy = { at: Date.now(), origins };
      return origins;
    });
    loading = pending;
    const done = () => {
      if (loading === pending) loading = null;
    };
    pending.then(done, done);
    return pending;
  };

  return {
    /** The business this origin belongs to once verified, or null. */
    async tenantOf(origin: string): Promise<string | null> {
      if (!isDomainOrigin(origin)) return null;
      return (await fresh()).get(origin) ?? null;
    },
    /** Drop the copy (an origin was verified or removed here); the next question loads again. */
    forget() {
      generation += 1;
      copy = null;
      loading = null;
    },
  };
}

const verified = originLookup(async () => {
  const d = schema.tenantDomains;
  // Loaded when first asked: @hykr/api reads no configuration when it loads.
  const { sharedDb } = await import('../../infra/db.js');
  const rows = await sharedDb.db
    .select({ origin: d.origin, tenantId: d.tenantId })
    .from(d)
    .where(isNotNull(d.verifiedAt));
  return new Map(rows.map((r) => [r.origin, r.tenantId]));
});

/**
 * The business a verified origin belongs to, or null. Other processes see a change within 30
 * seconds; this one at once (`forgetDomains`, after a settings write).
 */
export const verifiedTenantOf = (origin: string) => verified.tenantOf(origin);

/** Forget what this process knows of verified origins (one was verified or removed). */
export const forgetDomains = () => verified.forget();

/** Is this a business's verified origin? Only exact https origins ever are. */
export async function originAllowed(origin: string): Promise<boolean> {
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
