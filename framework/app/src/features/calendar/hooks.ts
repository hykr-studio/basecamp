import type { CalendarProvider, InviteRecipient } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
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

/**
 * Start connecting: the consent screen's URL, to open in the browser. The provider comes back
 * to this app: the web app's `/calendar`, or on a phone the app's own link
 * (`CALENDAR_APP_RETURN_URL`).
 */
export function useConnectCalendar(provider: CalendarProvider = 'google') {
  return useMutation({
    mutationFn: (chosen?: CalendarProvider) =>
      api.calendar.connect(chosen ?? provider, Platform.OS === 'web' ? 'web' : 'app'),
  });
}

/** Finish connecting with what the provider sent back: only as the person who started it. */
export function useCompleteCalendar() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string; state: string; provider?: CalendarProvider }) =>
      api.calendar.complete(
        { code: input.code, state: input.state },
        undefined,
        input.provider ?? 'google',
      ),
    onSettled: () => void client.invalidateQueries({ queryKey: ['calendar', 'connections'] }),
  });
}

/** Write the person's records to this calendar of theirs (one of several connected). */
export function useSetCalendarTarget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.calendar.setWriteTo(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['calendar', 'connections'] }),
  });
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
