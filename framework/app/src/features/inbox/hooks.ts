import type { InboxEntry, InboxPage } from '@hykr/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/** The signed-in person's inbox, newest first, with older pages on demand. */
export function useInbox() {
  const q = useInfiniteQuery({
    queryKey: ['inbox', 'list'],
    queryFn: ({ pageParam }) => api.inbox.list(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: '' as string,
    getNextPageParam: (last: InboxPage) => last.nextCursor ?? undefined,
  });
  const items: InboxEntry[] = (q.data?.pages ?? []).flatMap((p) => p.items);
  return {
    items,
    unread: q.data?.pages[0]?.unread ?? 0,
    loading: q.isLoading,
    error: q.error,
    hasMore: q.hasNextPage,
    loadMore: () => q.fetchNextPage(),
    refresh: () => q.refetch(),
  };
}

/** How many inbox items are not read yet (refreshed by live updates and on focus). */
export function useInboxCount(): number {
  const q = useQuery({
    queryKey: ['inbox', 'count'],
    queryFn: () => api.inbox.list({ unread: true, limit: 1 }),
    staleTime: 30_000,
  });
  return q.data?.unread ?? 0;
}

/** Mark items read, or all of them; the inbox refreshes. */
export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[] | 'all') =>
      ids === 'all' ? api.inbox.readAll() : api.inbox.read(ids),
    onSuccess: () => client.invalidateQueries({ queryKey: ['inbox'] }),
  });
}
