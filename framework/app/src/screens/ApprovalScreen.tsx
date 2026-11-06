import type { Approval } from '@hykr/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { Text } from '../components/ui/text';
import {
  ApprovalItem,
  DecisionScrollView,
  useShownInline,
  useStakes,
} from '../framework/ApprovalCard';
import { useScreenContext } from '../framework/assistant-context';
import { EmptyState } from '../framework/EmptyState';
import { useApprovals } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { Loading } from '../framework/Loading';
import { colors, styles } from '../theme';

const OUTCOME: Record<string, string> = {
  approved: 'Approved: it was done.',
  rejected: 'Not approved: nothing was changed.',
  expired: 'Nobody decided it in time: nothing was changed.',
  failed: "Approved, but it couldn't be done: nothing was changed.",
};

/**
 * One request, by its link (`/approvals/<id>`): what WhatsApp and other channels point to. The
 * person decides it here when it is theirs to decide; the requester sees their own request and
 * who decides it. Someone else's request, or another business's, is not found.
 */
export function ApprovalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useScreenContext({ screen: 'approval' });
  // This screen is the request's one decision surface while it is open.
  useShownInline(id, 'this request');
  const { approvals } = useApprovals();
  const waiting = approvals.find((a) => a.id === id);
  const fetched = useQuery({
    queryKey: ['approval', id],
    queryFn: () => api.getApproval(id),
    enabled: !!id && !waiting,
    staleTime: 0,
  });
  const approval = waiting ?? fetched.data;
  return (
    <DecisionScrollView contentContainerStyle={styles.content}>
      <Link href="/approvals" asChild>
        <Pressable
          accessibilityRole="link"
          className="min-h-11 flex-row items-center gap-1 self-start"
        >
          <Icon name="chevron-left" color={colors.primary} />
          <Text variant="label" className="text-primary">
            Approvals
          </Text>
        </Pressable>
      </Link>
      {!approval && fetched.isLoading && <Loading />}
      {!approval && fetched.error && (
        <EmptyState
          icon="inbox"
          title="This request isn't here"
          body="It may be someone else's to see, or the link is old."
        />
      )}
      {approval &&
        (approval.status === 'pending' ? (
          <ApprovalItem approval={approval} defaultOpen />
        ) : (
          <Decided approval={approval} />
        ))}
    </DecisionScrollView>
  );
}

/** A request that is no longer waiting: what it was and how it ended. */
function Decided({ approval }: { approval: Approval }) {
  const stakes = useStakes(approval);
  return (
    <View className="gap-1">
      <Text variant="title">{approval.summary ?? approval.action}</Text>
      {stakes && <Text variant="muted">{stakes}</Text>}
      <Text>{OUTCOME[approval.status] ?? approval.status}</Text>
      {approval.failureReason && <Text variant="muted">{approval.failureReason}</Text>}
    </View>
  );
}
