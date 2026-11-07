import type {
  AcceptanceChallengeInput,
  AcceptanceStatus,
  AcceptInput,
  ESignStarted,
  WriteResult,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useContext } from 'react';
import { api } from '../../api';

/**
 * Where the accept card's calls go: the person's own session (`api.acceptances`), or a share
 * link's guest calls (the share page provides those, decisions B9). `scope` keeps their cached
 * answers apart. A client without `esign` offers no signing at a provider.
 */
export interface AcceptanceClient {
  scope: string;
  status(documentId: string, lang?: string): Promise<AcceptanceStatus>;
  challenge(input: AcceptanceChallengeInput): Promise<WriteResult<{ id: string; sentTo: string }>>;
  accept(input: AcceptInput): Promise<WriteResult<unknown>>;
  esign?(input: {
    documentId: string;
    lang?: 'en' | 'hi' | 'te';
  }): Promise<WriteResult<ESignStarted>>;
}

const session: AcceptanceClient = {
  scope: 'session',
  status: (documentId, lang) => api.acceptances.status(documentId, lang),
  challenge: (input) => api.acceptances.challenge(input),
  accept: (input) => api.acceptances.accept(input),
  esign: (input) => api.acceptances.esign(input),
};

const AcceptanceClientContext = createContext<AcceptanceClient | null>(null);

/** Accept cards under it call `client` instead of the person's session. */
export function AcceptanceClientProvider({
  client,
  children,
}: {
  client: AcceptanceClient;
  children: ReactNode;
}) {
  return createElement(AcceptanceClientContext.Provider, { value: client }, children);
}

/** The client the accept card calls: a provider's, or the person's own session. */
export const useAcceptanceClient = () => useContext(AcceptanceClientContext) ?? session;

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
  const client = useAcceptanceClient();
  return useQuery({
    queryKey: ['acceptances', 'document', client.scope, documentId, lang],
    queryFn: () => client.status(documentId as string, lang),
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
  const client = useAcceptanceClient();
  return useMutation({
    mutationFn: (input: AcceptanceChallengeInput) => client.challenge(input),
  });
}

/**
 * Accept with the code received. The record moved (its transition), so the person's queries are
 * refreshed: the record, its documents and its acceptances.
 */
export function useAccept() {
  const client = useAcceptanceClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: AcceptInput) => client.accept(input),
    onSuccess: () => queries.invalidateQueries(),
  });
}

/** Start signing at the acceptance's e-sign provider: where to go. */
export function useStartESign() {
  const client = useAcceptanceClient();
  return useMutation({
    mutationFn: (input: { documentId: string; lang?: 'en' | 'hi' | 'te' }) => {
      if (!client.esign) throw new Error('Signing at a provider is not offered here');
      return client.esign(input);
    },
  });
}
