import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import { api } from '../../api';

/** Who keeps the business's connections: holders of this capability (owner, admin). */
export const INTEGRATIONS_MANAGE = 'integrations.manage';

const connectionsKey = ['integrations', 'connections'] as const;

/** May this person manage the business's integrations? */
export function useCanManageIntegrations(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
  return me.data?.capabilities.includes(INTEGRATIONS_MANAGE) ?? false;
}

/** The connectors this server offers. */
export function useConnectors() {
  return useQuery({
    queryKey: ['integrations', 'connectors'],
    queryFn: () => api.integrations.connectors(),
    staleTime: 10 * 60_000,
  });
}

/** The business's connections. */
export function useConnections() {
  return useQuery({ queryKey: connectionsKey, queryFn: () => api.integrations.connections() });
}

/**
 * Start signing a connector in (or `connectionId` in again): the consent screen's URL, to open
 * in the browser. The provider comes back to this app: the web app's `/integrations`, or on a
 * phone the app's own link (`INTEGRATIONS_APP_RETURN_URL`).
 */
export function useStartSignIn() {
  return useMutation({
    mutationFn: (input: { connector: string; connectionId?: string }) =>
      api.integrations.oauthStart(input.connector, {
        returnTo: Platform.OS === 'web' ? 'web' : 'app',
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      }),
  });
}

/** Finish signing in with what the provider sent back: only as the person who started it. */
export function useCompleteSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string; state: string }) => api.integrations.oauthComplete(input),
    onSettled: () => void client.invalidateQueries({ queryKey: connectionsKey }),
  });
}

/** The accounts (pages) a connection receives events for. */
export function usePickAccounts() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; accountIds: string[] }) =>
      api.integrations.oauthPick(input.id, input.accountIds),
    onSettled: () => void client.invalidateQueries({ queryKey: connectionsKey }),
  });
}

export function useDisconnect() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.integrations.disconnect(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: connectionsKey }),
  });
}
