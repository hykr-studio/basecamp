import type { InviteRecipient } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/** Whether this server offers each calendar service. */
export function useCalendarProviders() {
  return useQuery({
    queryKey: ['calendar', 'providers'],
    queryFn: () => api.calendar.providers(),
    staleTime: 10 * 60_000,
  });
}

/** The person's connected calendars. */
export function useCalendarConnections() {
  return useQuery({
    queryKey: ['calendar', 'connections'],
    queryFn: () => api.calendar.connections(),
  });
}

/** Start connecting: the consent screen's URL, to open in the browser. */
export function useConnectCalendar() {
  return useMutation({ mutationFn: () => api.calendar.connect('google') });
}

export function useDisconnectCalendar() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.calendar.disconnect(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['calendar', 'connections'] }),
  });
}

/** The person's private feeds (their URLs are shown only when made). */
export function useCalendarFeeds() {
  return useQuery({ queryKey: ['calendar', 'feeds'], queryFn: () => api.calendar.feeds() });
}

export function useCreateFeed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (label?: string) => api.calendar.createFeed(label),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['calendar', 'feeds'] }),
  });
}

export function useRevokeFeed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.calendar.revokeFeed(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['calendar', 'feeds'] }),
  });
}

const invitesKey = (entity: string, id: string) => ['calendar', 'invites', entity, id] as const;

/** A record's invites; polled while one is on its way. */
export function useInvites(entity: string, id: string) {
  return useQuery({
    queryKey: invitesKey(entity, id),
    queryFn: () => api.calendar.invites(entity, id),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((i) => i.status === 'queued' || i.status === 'sending')
        ? 1500
        : false,
  });
}

export function useSendInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (a: { entity: string; id: string; to: InviteRecipient[] }) =>
      api.calendar.invite(a),
    onSuccess: (_out, a) => void client.invalidateQueries({ queryKey: invitesKey(a.entity, a.id) }),
  });
}
