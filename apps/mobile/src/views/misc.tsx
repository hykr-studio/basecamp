import type { ApprovalCardView, KpiRowView, PageListView } from '@app/ui-registry';
import type { ViewProps } from '@app/ui-registry/react';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { api } from '../api';
import { ApprovalItem, useShownInline } from '../framework/ApprovalCard';
import { useApprovals } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { colors } from '../theme';
import { OpenRow, Rows, ViewCard } from './parts';

const DECIDED = {
  approved: ['check-circle', colors.success, 'Approved by you, and done'],
  rejected: ['slash', colors.muted, 'Rejected by you; nothing changed'],
  expired: ['clock', colors.muted, 'Expired; nothing changed'],
  failed: ['x-circle', colors.danger, "Approved, but it couldn't be done"],
} as const;

/**
 * A parked request, decided right here: the same ApprovalItem as everywhere else (so the
 * global bar leaves it out), then what became of it.
 */
export function ApprovalCardComponent({ approvalId, summary }: ViewProps<typeof ApprovalCardView>) {
  const { approvals } = useApprovals();
  const pending = approvals.find((a) => a.id === approvalId);
  useShownInline(pending?.id);
  const decided = useQuery({
    queryKey: ['approval', approvalId],
    queryFn: () => api.getApproval(approvalId),
    enabled: !pending,
    staleTime: 0,
  });
  if (pending) {
    return (
      <View className="gap-2 rounded-card border border-approval-border bg-approval-bg p-3">
        <ApprovalItem approval={pending} />
      </View>
    );
  }
  const status = decided.data?.status;
  if (!status || status === 'pending') return null;
  const [icon, tone, label] = DECIDED[status];
  return (
    <ViewCard>
      <View className="flex-row items-start gap-2">
        <Icon name={icon} color={tone} size={16} />
        <View className="flex-1 gap-0.5">
          <Text className="font-semibold">{summary ?? decided.data?.summary}</Text>
          <Text variant="muted" style={{ color: tone }}>
            {label}
            {status === 'failed' && decided.data?.failureReason
              ? `: ${decided.data.failureReason}`
              : ''}
          </Text>
        </View>
      </View>
    </ViewCard>
  );
}

export function KpiRowComponent({ items }: ViewProps<typeof KpiRowView>) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {items.map((k) => (
        <View
          key={k.label}
          className="min-w-28 flex-1 gap-0.5 rounded-card border border-border bg-card p-3"
        >
          <Text variant="title" className="tabular-nums">
            {k.value}
          </Text>
          <Text variant="label">{k.label}</Text>
          {k.hint ? <Text variant="muted">{k.hint}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** The person's saved pages (page.list); each opens beside the chat. */
export function PageListComponent({ title, items, act }: ViewProps<typeof PageListView>) {
  return (
    <ViewCard title={title ?? 'Pages'} count={items.length}>
      <Rows items={items} empty="No saved pages yet.">
        {(p) => (
          <OpenRow label={`Open ${p.name}`} onPress={() => act('open', p)}>
            <Text className="font-semibold">{p.name}</Text>
            <Text variant="muted">{p.spec.blocks.length} blocks</Text>
          </OpenRow>
        )}
      </Rows>
    </ViewCard>
  );
}
