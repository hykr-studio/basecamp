import { ApiError } from '@app/api-client';
import {
  type CommandSpec,
  type ListInput,
  MeetingSpec,
  NoteSpec,
  TodoSpec,
  type WriteResult,
} from '@app/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { api } from '../api';

/** The entities the app shows, by the name used in routes and query keys. */
export const specs = { todos: TodoSpec, notes: NoteSpec, meetings: MeetingSpec } as const;
export type EntityName = keyof typeof specs;
type Read<N extends EntityName> = z.infer<(typeof specs)[N]['schemas']['read']>;

export const entityApi = <N extends EntityName>(name: N) => api.entity(specs[name]);

/** Infinite scroll over the list grammar: nextCursor is the page param. */
export function useEntityList<N extends EntityName>(name: N, query: ListInput = {}) {
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

export function useEntity<N extends EntityName>(name: N, id: string | undefined) {
  return useQuery({
    queryKey: [name, 'get', id],
    queryFn: () => entityApi(name).get(id as string) as Promise<Read<N>>,
    enabled: Boolean(id),
  });
}

/** After any write: the lists that might show it, and approvals (it may have been parked). */
function useInvalidate() {
  const client = useQueryClient();
  return (names: readonly string[]) =>
    Promise.all([...names, 'approvals'].map((n) => client.invalidateQueries({ queryKey: [n] })));
}

/** create / update / remove, each with a fresh idempotency key (the client makes one). */
export function useEntityMutation<N extends EntityName>(name: N) {
  const invalidate = useInvalidate();
  const onSuccess = () => invalidate([name]);
  const create = useMutation({
    mutationFn: (input: Parameters<ReturnType<typeof entityApi<N>>['create']>[0]) =>
      entityApi(name).create(input),
    onSuccess,
  });
  const update = useMutation({
    mutationFn: (a: {
      id: string;
      patch: Parameters<ReturnType<typeof entityApi<N>>['update']>[1];
    }) => entityApi(name).update(a.id, a.patch),
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
    onSuccess: () => invalidate(Object.keys(specs)),
  });
}

export function useApprovals() {
  const invalidate = useInvalidate();
  const list = useQuery({ queryKey: ['approvals'], queryFn: () => api.listApprovals() });
  const decide = useMutation({
    mutationFn: (a: { id: string; approve: boolean }) => api.decideApproval(a.id, a.approve),
    onSuccess: () => invalidate(Object.keys(specs)),
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
