import type {
  DocumentChannel,
  DocumentInfo,
  DocumentRecipient,
  RenderDocumentInput,
} from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

const listKey = (entity: string, id: string) => ['documents', entity, id] as const;

/** The kinds of document an entity has (from the server: the application declares them). */
export function useDocumentKinds(entity: string) {
  return useQuery({
    queryKey: ['documents', 'kinds', entity],
    queryFn: () => api.documents.kinds(entity),
    staleTime: 10 * 60_000,
  });
}

const pending = (docs: readonly DocumentInfo[] | undefined) =>
  (docs ?? []).some((d) => d.status === 'pending');

/** A record's documents the person reaches, newest first; polled while one is being made. */
export function useDocuments(entity: string, id: string) {
  return useQuery({
    queryKey: listKey(entity, id),
    queryFn: () => api.documents.list(entity, id),
    refetchInterval: (q) => (pending(q.state.data) ? 1500 : false),
  });
}

/**
 * One document with its sends and a fresh short-lived URL, polled while it is being made or a
 * send is on its way, and refreshed before the URL expires.
 */
export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: ['document', id],
    queryFn: () => api.documents.get(id as string),
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      const going = (d.sends ?? []).some(
        (s) => s.status === 'queued' || s.status === 'waiting' || s.status === 'sending',
      );
      return d.status === 'pending' || going ? 1500 : 4 * 60_000;
    },
  });
}

/** Make a new version of a record's document. */
export function useRenderDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RenderDocumentInput) => api.documents.render(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/** Send a document (to yourself: `{ self: true }`). */
export function useSendDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (a: { documentId: string; to: DocumentRecipient; channel?: DocumentChannel }) =>
      api.documents.send(a.documentId, a.to, a.channel),
    onSuccess: (_out, a) => void client.invalidateQueries({ queryKey: ['document', a.documentId] }),
  });
}
