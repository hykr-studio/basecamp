import type { EntitySpec, RecordVersion, SlaTimer, WriteResult } from '@hykr/contracts';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/**
 * Move a record along its state machine (POST /api/transitions): done, or needs_approval when
 * the move waits. Afterwards every list, the record, its clocks and versions, approvals and
 * history refresh (a move may start or end SLAs, or park).
 */
export function useTransition(spec: EntitySpec) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; transition: string; input?: Record<string, unknown> }) =>
      api.transition(spec, a.id, a.transition, (a.input ?? {}) as never) as Promise<WriteResult>,
    onSuccess: () =>
      Promise.all(
        [spec.plural, 'sla', 'versions', 'approvals', 'history'].map((k) =>
          client.invalidateQueries({ queryKey: [k] }),
        ),
      ),
  });
}

/** A record's SLA clocks (by its entity's plural), as GET /api/sla/:plural/:id gives them. */
export function useSlaTimers(plural: string, id: string | undefined): UseQueryResult<SlaTimer[]> {
  return useQuery({
    queryKey: ['sla', plural, id],
    queryFn: () => api.sla.of(plural, id as string),
    enabled: Boolean(id),
    // A countdown moves on its own: refresh now and then.
    refetchInterval: 60_000,
  });
}

/** The revisions of a versioned record's series, oldest first. */
export function useVersions(type: string, id: string | undefined): UseQueryResult<RecordVersion[]> {
  return useQuery({
    queryKey: ['versions', type, id],
    queryFn: () => api.versions(type, id as string),
    enabled: Boolean(id),
  });
}

/** What the signed-in person may do here (capabilities), to offer only the moves they may make. */
export function useCapabilities(): readonly string[] | undefined {
  return useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 5 * 60_000 }).data
    ?.capabilities;
}
