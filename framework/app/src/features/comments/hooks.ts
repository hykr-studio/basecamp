import type { AddCommentInput, CommentPage, Me, Mention } from '@hykr/contracts';
import { CommentCapabilities } from '@hykr/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/** One record's comments, oldest first (pages of older ones load on demand). */
export function useComments(entity: string, id: string) {
  const q = useInfiniteQuery({
    queryKey: ['comments', entity, id],
    queryFn: ({ pageParam }) =>
      api.comments.list({ entity, id, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '' as string,
    getNextPageParam: (last: CommentPage) => last.nextCursor ?? undefined,
  });
  const items = (q.data?.pages ?? []).flatMap((p) => p.items).reverse();
  return {
    items,
    loading: q.isLoading,
    error: q.error,
    hasEarlier: q.hasNextPage,
    loadEarlier: () => q.fetchNextPage(),
    refresh: () => q.refetch(),
  };
}

/** Who a comment on this record may name, for the word typed after @ (null: not typing one). */
export function useMentionable(entity: string, id: string, q: string | null, internal: boolean) {
  return useQuery({
    queryKey: ['comments', entity, id, 'mentionable', q, internal],
    queryFn: () => api.comments.mentionable({ entity, id, q: q ?? '', internal }),
    enabled: q !== null,
    staleTime: 30_000,
    select: (page) => page.items as Mention[],
  });
}

/** The signed-in person's standing here: whether they may write team-only comments. */
export function useCanWriteInternal(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
  return (
    (me.data as Me | undefined)?.capabilities.includes(CommentCapabilities.internal.name) ?? false
  );
}

/** Add, edit and remove comments on one record; each refreshes the discussion and history. */
export function useCommentActions(entity: string, id: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['comments', entity, id] }),
      client.invalidateQueries({ queryKey: ['history', entity, id] }),
    ]);
  const add = useMutation({
    mutationFn: (input: Omit<AddCommentInput, 'entity' | 'recordId'>) =>
      api.comments.add({ entity, recordId: id, ...input }),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: (a: { commentId: string; body: string }) => api.comments.edit(a.commentId, a.body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => api.comments.remove(commentId),
    onSuccess: refresh,
  });
  return { add, edit, remove };
}
