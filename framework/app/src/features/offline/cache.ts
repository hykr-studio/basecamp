// The persisted query cache (B12): what a person read, kept on the device per person and business,
// so screens show it while offline and after a restart. Only answers that succeeded are kept;
// signing out removes them.
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { QueryClient } from '@tanstack/react-query';
import { type Persister, persistQueryClient } from '@tanstack/react-query-persist-client';
import type { KeyValue } from './device';

export type CacheOptions = {
  /** How long a kept answer is shown: older ones are dropped. */
  maxAgeMs: number;
  /** Changes when kept answers no longer fit the app (a new release with other shapes). */
  buster: string;
};

/** The key a person's cache is kept under, in one business (null: their default). */
export const cacheKey = (userId: string, business: string | null) =>
  `basecamp.query-cache.${userId}.${business ?? 'default'}`;

/** Where the businesses a person's caches were kept for are listed, so sign-out finds them all. */
const indexKey = (userId: string) => `basecamp.query-cache.${userId}`;

async function listed(kv: KeyValue, userId: string): Promise<(string | null)[]> {
  try {
    const raw = await kv.getItem(indexKey(userId));
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(value) ? value.filter((b) => b === null || typeof b === 'string') : [];
  } catch {
    return [];
  }
}

async function remember(kv: KeyValue, userId: string, business: string | null) {
  const now = await listed(kv, userId);
  if (!now.includes(business))
    await kv.setItem(indexKey(userId), JSON.stringify([...now, business]));
}

const persisterFor = (kv: KeyValue, key: string): Persister =>
  createAsyncStoragePersister({ storage: kv, key, throttleTime: 1000 });

/**
 * Restore this person's kept answers into the client and keep it saved from now on. Returns the
 * stop. Queries stay in memory as long as they are kept, so a screen opened later offline finds
 * them.
 */
export function persistCache(
  client: QueryClient,
  kv: KeyValue,
  who: { userId: string; business: string | null },
  options: CacheOptions,
): () => void {
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, gcTime: Math.max(options.maxAgeMs, 5 * 60_000) },
  });
  void remember(kv, who.userId, who.business).catch(() => {});
  const [stop] = persistQueryClient({
    queryClient: client,
    persister: persisterFor(kv, cacheKey(who.userId, who.business)),
    maxAge: options.maxAgeMs,
    buster: options.buster,
    dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === 'success' },
  });
  return stop;
}

/** Forget every answer kept for this person (sign-out), in every business they used here. */
export async function forgetCache(kv: KeyValue, userId: string) {
  for (const b of new Set([null, ...(await listed(kv, userId))]))
    await kv.removeItem(cacheKey(userId, b));
  await kv.removeItem(indexKey(userId));
}
