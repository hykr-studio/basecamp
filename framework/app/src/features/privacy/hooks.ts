import type { FilePrivacyRequestInput, PrivacyRequest } from '@hykr/contracts';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/** The signed-in person's own privacy requests, newest first, refreshed while one runs. */
export function useMyPrivacyRequests(): UseQueryResult<PrivacyRequest[]> {
  return useQuery({
    queryKey: ['privacy', 'mine'],
    queryFn: () => api.privacy.list({ mine: 'true' }),
    refetchInterval: (q) =>
      (q.state.data as PrivacyRequest[] | undefined)?.some((r) => r.status === 'in_progress')
        ? 2_000
        : false,
  });
}

/** Ask for a copy of your data, or to be forgotten (`POST /api/privacy/requests`). */
export function useFilePrivacyRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: FilePrivacyRequestInput) => api.privacy.request(input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['privacy'] }),
  });
}
