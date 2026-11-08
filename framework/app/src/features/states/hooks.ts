import type {
  EntitySpec,
  Principal,
  RecordVersion,
  SlaListInput,
  SlaPage,
  SlaTimer,
  WriteResult,
} from '@hykr/contracts';
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

/**
 * The signed-in person as a transition's checks see them (their roles and capabilities in this
 * business), to offer only the moves they may make; undefined until it loads. The server checks
 * again: this only greys buttons. With no business, no tenant (a transition's checks then refuse).
 */
export function useActingPrincipal(): Principal | undefined {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 5 * 60_000 }).data;
  return me
    ? {
        actor: { kind: 'user', id: me.userId },
        subject: { kind: 'user', userId: me.userId },
        ...(me.tenantId ? { tenantId: me.tenantId } : {}),
        ...(me.customerId ? { customerId: me.customerId } : {}),
        roles: me.roles,
        capabilities: me.capabilities,
        assurance: 'session',
        scopes: [],
      }
    : undefined;
}

/**
 * The business's SLA clocks in one status (breached by default) on records the person reads;
 * `open: true` for only those still running late. One page (`items`, earliest due first); its
 * `nextCursor`, passed as `cursor`, asks for the next.
 */
export function useSlaList(q: SlaListInput = {}): UseQueryResult<SlaPage> {
  return useQuery({
    queryKey: ['sla', 'list', q],
    queryFn: () => api.sla.list(q),
    refetchInterval: 60_000,
  });
}
