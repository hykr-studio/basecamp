import { ApiError, type EntityClient } from '@hykr/api-client';
import type { Catalog, CommandSpec, ListInput, WriteResult } from '@hykr/contracts';
import {
  type InfiniteData,
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

/**
 * Where an application tells the type system which catalog it runs, so entity names and rows
 * are typed in its screens. Without it, any name is accepted and rows are loosely typed.
 *
 *   declare module '@hykr/app' {
 *     interface Register { catalog: typeof catalog }
 *   }
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled in by the application's declaration.
export interface Register {}

/** The application's catalog type, once registered; the general Catalog until then. */
export type RegisteredCatalog = Register extends { catalog: infer C extends Catalog } ? C : Catalog;
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
type Written<N extends EntityName> = WriteResult<Read<N>>;

/** One entity's list, loaded a page at a time. */
export type EntityList<N extends EntityName> = {
  items: Read<N>[];
  loadMore: () => void;
  hasMore: boolean;
  refresh: () => unknown;
  loading: boolean;
  error: Error | null;
};

/** create / update / remove for one entity. */
export type EntityMutations<N extends EntityName> = {
  create: UseMutationResult<Written<N>, Error, Parameters<Client<N>['create']>[0]>;
  update: UseMutationResult<
    Written<N>,
    Error,
    { id: string; patch: Parameters<Client<N>['update']>[1] }
  >;
  remove: UseMutationResult<WriteResult<null>, Error, string>;
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
  };
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

/** create / update / remove, each with a fresh idempotency key (the client makes one). */
export function useEntityMutation<N extends EntityName>(name: N): EntityMutations<N> {
  const invalidate = useInvalidate();
  const onSuccess = () => invalidate([name]);
  const create = useMutation({
    mutationFn: (input: Parameters<Client<N>['create']>[0]) => entityApi(name).create(input),
    onSuccess,
  });
  const update = useMutation({
    mutationFn: (a: { id: string; patch: Parameters<Client<N>['update']>[1] }) =>
      entityApi(name).update(a.id, a.patch),
    onSuccess,
  });
  const remove = useMutation({ mutationFn: (id: string) => entityApi(name).remove(id), onSuccess });
  return { create, update, remove };
}

/** Send a command; the result is done or needs_approval, so the screen can show either. */
export function useCommand<S extends CommandSpec>(spec: S) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: z.input<S['input']>) =>
      api.command(spec, input) as Promise<WriteResult<z.infer<S['output']>>>,
    // A command can touch any entity: refresh them all.
    onSuccess: () => invalidate(Object.keys(specs())),
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
