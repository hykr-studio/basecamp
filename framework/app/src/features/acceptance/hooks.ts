import type { AcceptanceChallengeInput, AcceptInput } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

/** The acceptances an entity's records have (from the server: the application declares them). */
export function useAcceptanceKinds(entity: string) {
  return useQuery({
    queryKey: ['acceptances', 'kinds', entity],
    queryFn: () => api.acceptances.kinds(entity),
    staleTime: 10 * 60_000,
  });
}

/** One PDF's acceptance for the person: what they agree to, where a code goes, may they. */
export function useAcceptanceStatus(documentId: string | undefined, lang?: string) {
  return useQuery({
    queryKey: ['acceptances', 'document', documentId, lang],
    queryFn: () => api.acceptances.status(documentId as string, lang),
    enabled: !!documentId,
  });
}

/** A record's acceptances the person may see, newest first. */
export function useAcceptances(entity: string, id: string) {
  return useQuery({
    queryKey: ['acceptances', entity, id],
    queryFn: () => api.acceptances.list(entity, id),
  });
}

/** Send a one-time code to the person's own number or email, for one PDF. */
export function useRequestAcceptanceCode() {
  return useMutation({
    mutationFn: (input: AcceptanceChallengeInput) => api.acceptances.challenge(input),
  });
}

/**
 * Accept with the code received. The record moved (its transition), so the person's queries are
 * refreshed: the record, its documents and its acceptances.
 */
export function useAccept() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptInput) => api.acceptances.accept(input),
    onSuccess: () => client.invalidateQueries(),
  });
}

/** Start signing at the acceptance's e-sign provider: where to go. */
export function useStartESign() {
  return useMutation({
    mutationFn: (input: { documentId: string; lang?: 'en' | 'hi' | 'te' }) =>
      api.acceptances.esign(input),
  });
}
