import { type CreateShareInput, ShareCapabilities, type ShareTarget } from '@hykr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';

const keyOf = (target: ShareTarget) => ['shares', target] as const;

/** May the signed-in person share by link here (`shares.create`)? */
export function useCanShare(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
  return me.data?.capabilities.includes(ShareCapabilities.create.name) ?? false;
}

/** May they revoke anyone's link (`shares.manage`)? */
export function useManagesShares(): boolean {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
  return me.data?.capabilities.includes(ShareCapabilities.manage.name) ?? false;
}

/** What the application lets a business share: entities and forms. */
export function useShareKinds() {
  return useQuery({
    queryKey: ['shares', 'kinds'],
    queryFn: () => api.shares.kinds(),
    staleTime: 10 * 60_000,
  });
}

/** A record's, a page's or a form's links, newest first. */
export function useShares(target: ShareTarget, enabled = true) {
  return useQuery({ queryKey: keyOf(target), queryFn: () => api.shares.list(target), enabled });
}

/** Make a link: its URL is in the answer only. */
export function useCreateShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateShareInput) => api.shares.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['shares'] }),
  });
}

export function useRevokeShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.shares.revoke(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['shares'] }),
  });
}
