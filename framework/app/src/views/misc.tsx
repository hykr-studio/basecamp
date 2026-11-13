import type { EntitySpec } from '@hykr/contracts';
import {
  type ApprovalCardView,
  type KpiRowView,
  type KpiSource,
  kpiTiles,
  type MemoryListView,
  type PageListView,
} from '@hykr/ui-registry';
import type { ViewProps } from '@hykr/ui-registry/react';
import { useContext } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '../components/ui/text';
import {
  ApprovalItem,
  LeaveChat,
  revealDecision,
  useApprovalStatus,
  useDecisionPlace,
} from '../framework/ApprovalCard';
import { errorMessage, useEntitySummary } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { useLang } from '../framework/lang';
import { getCatalog } from '../runtime';
import { colors } from '../theme';
import { ByAssistant, OpenRow, Rows, ViewCard } from './parts';

const DECIDED = {
  approved: ['check-circle', colors.success, 'Approved by you, and done'],
  rejected: ['slash', colors.muted, 'Rejected by you; nothing changed'],
  expired: ['clock', colors.muted, 'Expired; nothing changed'],
  failed: ['x-circle', colors.danger, "Approved, but it couldn't be done"],
} as const;
/** The same, for a request someone else decided (its `canDecide` is false): not "by you". */
const DECIDED_TEAM = {
  ...DECIDED,
  approved: ['check-circle', colors.success, 'Approved, and done'],
  rejected: ['slash', colors.muted, 'Rejected; nothing changed'],
} as const;

/**
 * A parked request in the chat. It is decided in exactly one place: here, when nothing else
 * shows it; otherwise this is a pointer to the place that does (the screen's own draft, or an
 * earlier card in the thread). Once decided, only what became of it.
 */
export function ApprovalCardComponent({
  approvalId,
  summary,
  canDecide,
}: ViewProps<typeof ApprovalCardView>) {
  const { approval, status } = useApprovalStatus(approvalId);
  // Someone else decides it: the words never say "you".
  const theirs = canDecide === false || approval?.canDecide === false;
  const pending = status === 'pending' ? approval : undefined;
  const place = useDecisionPlace(pending?.id);
  const leaveChat = useContext(LeaveChat);
  if (pending && place.here) {
    return (
      <View className="gap-2 rounded-card border border-approval-border bg-approval-bg p-3">
        <ApprovalItem approval={pending} />
      </View>
    );
  }
  if (pending && !place.here) {
    const who = theirs ? 'the team' : 'you';
    const where = place.onScreen
      ? `Waiting for ${who} on ${place.where ?? 'the page'}`
      : `Waiting for ${who} above`;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${summary ?? pending.summary ?? 'A request'}: ${where}. Show it`}
        onPress={() => {
          leaveChat?.();
          // After the sheet steps aside, so the target is laid out where it will stay.
          setTimeout(() => revealDecision(pending.id), leaveChat ? 150 : 0);
        }}
        className="-mx-1 min-h-11 flex-row items-center gap-2 self-start rounded-control px-1 web:hover:bg-approval-bg"
      >
        <Icon name="clock" color={colors.approvalText} size={16} />
        <Text className="shrink font-semibold text-approval-text">{where}</Text>
        <Icon name="arrow-right" color={colors.approvalText} size={16} />
      </Pressable>
    );
  }
  if (!status || status === 'pending') return null;
  const [icon, tone, label] = (theirs ? DECIDED_TEAM : DECIDED)[status];
  return (
    <View className="flex-row items-start gap-2">
      <Icon name={icon} color={tone} size={16} />
      <View className="flex-1 gap-0.5">
        <Text className="font-semibold">{summary ?? approval?.summary}</Text>
        <Text variant="muted" style={{ color: tone }}>
          {label}
          {status === 'failed' && approval?.failureReason ? `: ${approval.failureReason}` : ''}
        </Text>
      </View>
    </View>
  );
}

type KpiTile = { label: string; value: number | string; hint?: string };

function KpiTiles({ items }: { items: readonly KpiTile[] }) {
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

/** Tiles from a summary, fetched now with the person's session: never numbers someone typed. */
function KpiOf({ of }: { of: KpiSource }) {
  const summary = useEntitySummary(of.entity, of.query);
  const { lang } = useLang();
  if (summary.error)
    return <Text variant="error">Couldn't load this: {errorMessage(summary.error)}</Text>;
  if (!summary.data)
    return (
      <View className="flex-row items-center gap-2 py-2">
        <ActivityIndicator size="small" color={colors.muted} />
      </View>
    );
  const spec = (getCatalog().entities as Record<string, EntitySpec>)[of.entity];
  return <KpiTiles items={kpiTiles(summary.data, of, { spec, lang })} />;
}

export function KpiRowComponent({ items, of }: ViewProps<typeof KpiRowView>) {
  if (of) return <KpiOf of={of} />;
  return <KpiTiles items={items ?? []} />;
}

/** The person's saved pages (page.list); each opens beside the chat. */
export function PageListComponent({ title, items, act, words }: ViewProps<typeof PageListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
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

/** The business's memories (memory.list): one fact a row, marked when the assistant wrote it. */
export function MemoryListComponent({ title, items, words }: ViewProps<typeof MemoryListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(m) => (
          <View className="gap-1 py-2">
            <Text>{m.text}</Text>
            {m.createdBy === 'assistant' ? <ByAssistant /> : null}
          </View>
        )}
      </Rows>
    </ViewCard>
  );
}
