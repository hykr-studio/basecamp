import type { DialCallInput, LogCallInput } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

const callsKey = (entity: string, id: string) => ['calls', entity, id] as const;

/** A record's calls, newest first; polled while one is being connected. */
export function useCalls(entity: string, id: string) {
  return useQuery({
    queryKey: callsKey(entity, id),
    queryFn: () => api.calls.list({ entity, id }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === 'requested' || c.status === 'ringing')
        ? 2000
        : false,
  });
}

/** Whether the business can place calls (a telephony provider it may use). */
export function useCallProvider() {
  return useQuery({
    queryKey: ['calls', 'provider'],
    queryFn: () => api.calls.provider(),
    staleTime: 5 * 60_000,
  });
}

/** Write down a call on a record. */
export function useLogCall() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: LogCallInput & { entity: string; id: string }) => api.calls.log(input),
    onSuccess: (_out, a) => void client.invalidateQueries({ queryKey: callsKey(a.entity, a.id) }),
  });
}

/** Click-to-call through the business's provider. */
export function useDialCall() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: DialCallInput & { entity: string; id: string }) => api.calls.dial(input),
    onSuccess: (_out, a) => void client.invalidateQueries({ queryKey: callsKey(a.entity, a.id) }),
  });
}
