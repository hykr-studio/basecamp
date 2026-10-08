import type { Approval } from '@app/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SectionHeading } from '../components/ScreenTitle';
import { colors, space, styles } from '../theme';
import { ApprovalItem, useShownInline } from './ApprovalCard';
import { AssistantMark } from './AssistantMark';
import { expiresIn } from './dates';
import { useApprovals } from './hooks';
import { isHovered } from './hover';
import { Icon } from './Icon';
import { useT } from './lang';

/**
 * One request as a line: what, who asked, how long it waits. Pressing it opens the same
 * decision the approvals card shows (ApprovalItem), in place. While it is on screen it is
 * this request's one decision surface: the global card and dock leave it out.
 */
function Waiting({ approval, initiallyOpen }: { approval: Approval; initiallyOpen: boolean }) {
  useShownInline(approval.id, 'Today');
  const { t } = useT();
  // On a phone the chevron alone says it opens; the line keeps its width for the words.
  const narrow = useWindowDimensions().width < 600;
  const [open, setOpen] = useState(initiallyOpen);
  const summary = approval.summary ?? approval.action;
  const byAssistant = approval.requestedBy === 'agent';
  if (open) {
    return (
      <View style={s.open}>
        <ApprovalItem approval={approval} />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: true }}
          accessibilityLabel={`Fold “${summary}”`}
          onPress={() => setOpen(false)}
          style={s.fold}
        >
          <Icon name="chevron-up" color={colors.approvalText} size={16} />
          <Text style={[styles.label, { color: colors.approvalText }]}>Fold</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: false }}
      accessibilityLabel={`${summary}. Decide`}
      onPress={() => setOpen(true)}
      style={(state) => [s.line, isHovered(state) && { backgroundColor: colors.card }]}
    >
      {byAssistant ? (
        <AssistantMark size={18} />
      ) : (
        <Icon name="inbox" color={colors.approvalText} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.text, { fontWeight: '600' }]} numberOfLines={2}>
          {summary}
        </Text>
        <Text
          style={[styles.muted, { color: byAssistant ? colors.assistant : colors.approvalText }]}
        >
          {byAssistant ? t('approval.askedBy') : t('approval.askedByYou')} ·{' '}
          {expiresIn(approval.expiresAt)}
        </Text>
      </View>
      {!narrow && <Text style={[styles.label, { color: colors.primary }]}>Decide</Text>}
      <Icon name="chevron-right" color={colors.primary} size={16} />
    </Pressable>
  );
}

/**
 * "Waiting for your decision": every request parked for this person, first on a home screen.
 * A lone request opens with its decision; several start as lines. Nothing waiting is one
 * quiet line, not an empty card.
 */
export function WaitingForYou() {
  const { approvals } = useApprovals();
  const count = approvals.length;
  if (count === 0) {
    return (
      <View style={[styles.row, { minHeight: 32 }]}>
        <Icon name="check-circle" color={colors.muted} size={16} />
        <Text style={styles.muted}>Nothing is waiting for your decision.</Text>
      </View>
    );
  }
  return (
    <View style={styles.section} accessibilityRole="summary">
      <SectionHeading>Waiting for your decision ({count})</SectionHeading>
      <View style={s.surface}>
        {approvals.map((a, i) => (
          <View key={a.id} style={i > 0 ? s.divider : undefined}>
            <Waiting approval={a} initiallyOpen={count === 1} />
          </View>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  surface: {
    backgroundColor: colors.approvalBg,
    borderColor: colors.approvalBorder,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  open: { padding: space.lg, gap: space.sm },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 44,
    alignSelf: 'flex-start',
  },
  divider: { borderTopWidth: 1, borderColor: colors.approvalBorder },
});
