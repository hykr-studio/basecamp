import { ApiError, type EntityClient, isNetworkError } from '@hykr/api-client';
import {
  type Catalog,
  type CommandSpec,
  commandQueuesOffline,
  type EntitySpec,
  type ListInput,
  type ModuleSpec,
  queuesOffline,
  type Summary,
  type SummaryInput,
  versionedOf,
  versionField,
  type WriteAction,
  type WriteResult,
} from '@hykr/contracts';
import {
  type InfiniteData,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import { api } from '../api';
import { getCatalog } from '../runtime';
import { useToast } from './Toast';
import { isQueued, type QueuedWrite, writeQueue } from './write-queue';

/**
 * Where an application tells the type system which catalog it runs, so entity names and rows
 * are typed in its screens. Without it, any name is accepted and rows are loosely typed. Either
 * its catalog, or its modules' isomorphic specs (`ModuleSpec`), whose entities are merged:
 *
 *   declare module '@hykr/app' {
 *     interface Register { catalog: typeof catalog }      // or: { modules: typeof modules }
 *   }
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled in by the application's declaration.
export interface Register {}

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/** Every module's entities in one map: the intersection of their `entities`. */
export type MergedEntities<M extends readonly { entities: Record<string, EntitySpec> }[]> = [
  M[number],
] extends [never]
  ? Record<never, EntitySpec>
  : UnionToIntersection<M[number]['entities']> extends infer E extends Record<string, EntitySpec>
    ? E
    : never;

/**
 * The catalog type a registration declares: its `catalog`, or a catalog of its `modules`'
 * merged entities (plus the platform's), or the general Catalog.
 */
export type CatalogOf<R> = R extends { catalog: infer C extends Catalog }
  ? C
  : R extends { modules: infer M extends readonly ModuleSpec[] }
    ? Catalog<MergedEntities<M>>
    : Catalog;

/** The application's catalog type, once registered; the general Catalog until then. */
export type RegisteredCatalog = CatalogOf<Register>;
type Entities = RegisteredCatalog['entities'];

/**
 * Every entity the app can show, by the plural used in routes and query keys: the domain's
 * and the framework's, straight from the application's catalog. A new entity needs nothing here.
 */
export const specs = (): Entities => getCatalog().entities as Entities;
export type EntityName = keyof Entities & string;
type Read<N extends EntityName> = z.infer<Entities[N]['schemas']['read']>;
// Return types are spelled out below, so the published declarations keep them in terms of
// Register (and so typed by the application's catalog), not the catalog seen at build time.
type Client<N extends EntityName> = EntityClient<Entities[N]>;
/**
 * A write's answer: done or waiting for approval, or, for an entity or command its module marks
 * `offline`, kept on the device to sync later (`queued`, decisions B12).
 */
type Written<N extends EntityName> = WriteResult<Read<N>> | QueuedWrite;

/** One entity's list, loaded a page at a time. */
export type EntityList<N extends EntityName> = {
  items: Read<N>[];
  loadMore: () => void;
  hasMore: boolean;
  refresh: () => unknown;
  loading: boolean;
  error: Error | null;
  /** Waiting for a network: what it shows (if anything) is what was kept on the device. */
  offline: boolean;
};

/** create / update / remove for one entity. */
export type EntityMutations<N extends EntityName> = {
  create: UseMutationResult<Written<N>, Error, Parameters<Client<N>['create']>[0]>;
  update: UseMutationResult<
    Written<N>,
    Error,
    { id: string; patch: Parameters<Client<N>['update']>[1] }
  >;
  remove: UseMutationResult<WriteResult<null> | QueuedWrite, Error, string>;
};

export const entityApi = <N extends EntityName>(name: N): Client<N> =>
  api.entity(specs()[name] as Entities[N]) as Client<N>;

/** Infinite scroll over the list grammar: nextCursor is the page param. */
export function useEntityList<N extends EntityName>(name: N, query: ListInput = {}): EntityList<N> {
  const q = useInfiniteQuery({
    queryKey: [name, 'list', query],
    queryFn: ({ pageParam }) =>
      entityApi(name).list(pageParam ? { ...query, cursor: pageParam } : query),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  return {
    items: (q.data?.pages.flatMap((p) => p.items) ?? []) as Read<N>[],
    loadMore: () => {
      if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
    },
    hasMore: q.hasNextPage,
    refresh: q.refetch,
    loading: q.isLoading,
    error: q.error,
    offline: q.fetchStatus === 'paused',
  };
}

/**
 * Counts and totals of an entity's records (GET /api/<plural>/summary), with the person's
 * session. Keyed under the entity, so its writes, the assistant's and live events refresh it
 * like its lists. Takes any plural: views name entities by plural (kpi.row's `of`).
 */
export function useEntitySummary(
  name: EntityName | (string & {}),
  query: SummaryInput = {},
): UseQueryResult<Summary> {
  return useQuery({
    queryKey: [name, 'summary', query],
    queryFn: () => api.summary(name, query),
  });
}

export function useEntity<N extends EntityName>(
  name: N,
  id: string | undefined,
): UseQueryResult<Read<N>> {
  return useQuery({
    queryKey: [name, 'get', id],
    queryFn: () => entityApi(name).get(id as string) as Promise<Read<N>>,
    enabled: Boolean(id),
  });
}

/**
 * After any write: the lists that might show it, approvals (it may have been parked) and
 * history (every write leaves an audit row).
 */
function useInvalidate() {
  const client = useQueryClient();
  return (names: readonly string[]) =>
    Promise.all(
      [...names, 'approvals', 'history'].map((n) => client.invalidateQueries({ queryKey: [n] })),
    );
}

type Row = Record<string, unknown> & { id?: unknown };

/** Each cached copy of a record in a query's data: a get's row, or a row of a list's pages. */
function mapRows(data: unknown, id: string, fn: (row: Row) => Row | null): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as Row & { pages?: { items?: Row[] }[] };
  if (d.id === id) return fn(d) ?? data;
  if (!Array.isArray(d.pages)) return data;
  let touched = false;
  const pages = d.pages.map((page) => {
    if (!Array.isArray(page?.items) || !page.items.some((i) => i?.id === id)) return page;
    touched = true;
    return {
      ...page,
      items: page.items.flatMap((i) => (i?.id === id ? (fn(i) ?? []) : [i])),
    };
  });
  return touched ? { ...d, pages } : data;
}

/** The record as the app last read it (a get, or an item of a list), if it is cached. */
export function cachedRecord(
  client: QueryClient,
  name: string,
  id: string,
): Record<string, unknown> | undefined {
  let found: Row | undefined;
  for (const [, data] of client.getQueriesData({ queryKey: [name] }))
    if (!found)
      mapRows(data, id, (row) => {
        found = row;
        return row;
      });
  return found;
}

const titleOf = (...from: (Record<string, unknown> | undefined)[]) => {
  for (const v of from) if (typeof v?.title === 'string' && v.title) return v.title;
  return undefined;
};

/**
 * One entity write, the way the app's hooks and views make it: to the offline outbox when the
 * entity's module marks this write `offline` and the offline plugin runs (kept on the device,
 * sent with a key fixed now, based on the version the person saw), otherwise straight to the
 * API. A queued update shows in the cached lists at once, and a queued delete leaves them.
 */
export async function writeEntity(
  client: QueryClient,
  name: EntityName | (string & {}),
  action: WriteAction,
  args: { id?: string; input?: Record<string, unknown> },
): Promise<WriteResult<unknown> | QueuedWrite> {
  const spec = (specs() as Record<string, EntitySpec>)[name];
  if (!spec) throw new Error(`No entity called ${name}`);
  const queue = writeQueue();
  if (!queue || !queuesOffline(spec, action)) {
    const c = api.entity(spec);
    if (action === 'create') return c.create(args.input as never);
    if (action === 'update') return c.update(String(args.id), args.input as never);
    return c.remove(String(args.id));
  }
  const trait = versionedOf(spec);
  const field = trait ? versionField(trait) : undefined;
  const row = args.id ? cachedRecord(client, name, args.id) : undefined;
  const input =
    action === 'create'
      ? { id: crypto.randomUUID(), ...args.input }
      : action === 'update'
        ? { ...args.input }
        : {};
  const recordId = action === 'create' ? String(input.id) : args.id;
  const seen = field && row ? Number(row[field]) : undefined;
  const result = await queue.submit({
    op: { kind: 'entity', entity: name, action, ...(recordId ? { recordId } : {}) },
    input,
    title: titleOf(input, row),
    versioned: trait !== undefined,
    ...(seen !== undefined && Number.isFinite(seen) ? { baseVersion: seen } : {}),
  });
  if (isQueued(result) && args.id) {
    const id = args.id;
    const next = result.item.ifMatch !== undefined ? result.item.ifMatch + 1 : undefined;
    client.setQueriesData({ queryKey: [name] }, (data: unknown) =>
      mapRows(data, id, (r) =>
        action === 'delete'
          ? null
          : { ...r, ...input, ...(field && next !== undefined ? { [field]: next } : {}) },
      ),
    );
  }
  return result;
}

/** One command, the same way: queued when its module marks it `offline`, else straight to the API. */
export async function writeCommand<S extends CommandSpec>(
  spec: S,
  input: z.input<S['input']>,
): Promise<WriteResult<z.infer<S['output']>> | QueuedWrite> {
  const queue = writeQueue();
  if (!queue || !commandQueuesOffline(spec))
    return api.command(spec, input) as Promise<WriteResult<z.infer<S['output']>>>;
  const values = input as Record<string, unknown>;
  return queue.submit({
    op: { kind: 'command', command: spec.name },
    input: values,
    title: titleOf(values),
  }) as Promise<WriteResult<z.infer<S['output']>> | QueuedWrite>;
}

/**
 * create / update / remove. A write on an entity its module marks `offline` goes through the
 * outbox (one idempotency key for all its tries; `queued` while it cannot be sent); any other
 * gets a fresh key per call and fails at once without a network.
 */
export function useEntityMutation<N extends EntityName>(name: N): EntityMutations<N> {
  const invalidate = useInvalidate();
  const client = useQueryClient();
  // Kept for later: nothing to refresh until it syncs (the outbox refreshes then).
  const onSuccess = (r: unknown) => (isQueued(r) ? undefined : invalidate([name]));
  const create = useMutation({
    networkMode: 'always',
    mutationFn: (input: Parameters<Client<N>['create']>[0]) =>
      writeEntity(client, name, 'create', { input: input as Record<string, unknown> }) as Promise<
        Written<N>
      >,
    onSuccess,
  });
  const update = useMutation({
    networkMode: 'always',
    mutationFn: (a: { id: string; patch: Parameters<Client<N>['update']>[1] }) =>
      writeEntity(client, name, 'update', {
        id: a.id,
        input: a.patch as Record<string, unknown>,
      }) as Promise<Written<N>>,
    onSuccess,
  });
  const remove = useMutation({
    networkMode: 'always',
    mutationFn: (id: string) =>
      writeEntity(client, name, 'delete', { id }) as Promise<WriteResult<null> | QueuedWrite>,
    onSuccess,
  });
  return { create, update, remove };
}

/**
 * Send a command; the result is done or needs_approval (or `queued`, for a command its module
 * marks `offline`), so the screen can show each.
 */
export function useCommand<S extends CommandSpec>(spec: S) {
  const invalidate = useInvalidate();
  return useMutation({
    networkMode: 'always',
    mutationFn: (input: z.input<S['input']>) => writeCommand(spec, input),
    // A command can touch any entity: refresh them all.
    onSuccess: (r) => (isQueued(r) ? undefined : invalidate(Object.keys(specs()))),
  });
}

export function useApprovals() {
  const invalidate = useInvalidate();
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['approvals'], queryFn: () => api.listApprovals() });
  const decide = useMutation({
    mutationFn: (a: { id: string; approve: boolean }) => api.decideApproval(a.id, a.approve),
    onSuccess: (decided) => {
      // Anything that showed this request (the chat's trace line) sees the decision at once,
      // even if it cached the request while it was still pending.
      client.setQueryData(['approval', decided.id], decided);
      return invalidate(Object.keys(specs()));
    },
  });
  return { approvals: list.data ?? [], decide };
}

/** A sentence a person can read, from whatever the API sent back. */
export function errorMessage(e: unknown): string {
  if (isNetworkError(e))
    return "You're offline, or the server can't be reached. Try again when you're back online.";
  if (e instanceof ApiError) {
    const body = e.body as {
      message?: unknown;
      reason?: string;
      errors?: { message?: string }[];
    } | null;
    const detail = body?.errors?.[0]?.message ?? body?.reason;
    if (detail) return detail;
    if (typeof body?.message === 'string') return body.message;
    return e.status === 429 ? 'Too many requests. Wait a minute and try again.' : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The person's own delete: hidden at once, committed after a few seconds unless they press
 * Undo. The same safety net the assistant's deletes get from approvals, without a dialog.
 */
export function useUndoableDelete<N extends EntityName>(name: N) {
  const client = useQueryClient();
  const toast = useToast();
  const { remove } = useEntityMutation(name);
  return (item: { id: string; title: string }) => {
    const key = { queryKey: [name, 'list'] };
    const before = client.getQueriesData(key);
    client.setQueriesData<InfiniteData<{ items: { id: string }[] }>>(key, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.filter((i) => i.id !== item.id),
            })),
          }
        : data,
    );
    let undone = false;
    const timer = setTimeout(() => {
      if (!undone) remove.mutate(item.id);
    }, 5000);
    toast.show({
      message: `Deleted “${item.title}”`,
      durationMs: 5000,
      action: {
        label: 'Undo',
        onPress: () => {
          undone = true;
          clearTimeout(timer);
          for (const [k, d] of before) client.setQueryData(k, d);
        },
      },
    });
  };
}
