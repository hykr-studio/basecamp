import type { Approval } from '@app/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Button } from '../components/Button';
import { colors, space, styles } from '../theme';
import { ApprovalPreview } from './ApprovalPreview';
import { expiresIn } from './dates';
import { errorMessage, useApprovals } from './hooks';
import { Icon } from './Icon';
import { useToast } from './Toast';

/*
 * Approvals a screen shows inline (the close form shows its own draft) are left out of the
 * global card, so each request has one place to decide it.
 */
const inline = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => [...inline].sort().join(',');

export function useShownInline(id: string | undefined) {
  useEffect(() => {
    if (!id) return;
    inline.add(id);
    emit();
    return () => {
      inline.delete(id);
      emit();
    };
  }, [id]);
}

/** One parked operation: what it is, who asked, exactly what it will write, and the decision. */
export function ApprovalItem({
  approval,
  defaultOpen = false,
}: {
  approval: Approval;
  defaultOpen?: boolean;
}) {
  const { decide } = useApprovals();
  const toast = useToast();
  const narrow = useWindowDimensions().width < 600;
  const [open, setOpen] = useState(defaultOpen);
  const summary = approval.summary ?? approval.action;
  const deciding = decide.isPending && decide.variables?.id === approval.id;

  async function run(approve: boolean) {
    try {
      const result = await decide.mutateAsync({ id: approval.id, approve });
      if (result.status === 'approved')
        toast.show({ tone: 'success', message: `Done: ${summary}` });
      else if (result.status === 'rejected')
        toast.show({ message: `Rejected: ${summary}. Nothing was changed.` });
      else if (result.status === 'failed')
        toast.show({
          tone: 'error',
          message: `Couldn't do it: ${result.failureReason}. Nothing was changed.`,
          durationMs: 9000,
        });
      else if (result.status === 'expired')
        toast.show({ tone: 'error', message: 'This request had expired. Nothing was changed.' });
    } catch (e) {
      toast.show({ tone: 'error', message: errorMessage(e) });
    }
  }

  return (
    <View style={s.item}>
      <View style={{ gap: 2 }}>
        <Text style={[styles.text, { fontWeight: '600' }]}>{summary}</Text>
        <Text style={[styles.muted, { color: colors.warnText }]}>
          {approval.requestedBy === 'agent' ? 'Asked by the assistant' : 'Asked by you'} ·{' '}
          {expiresIn(approval.expiresAt)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Hide' : 'Show'} what approving “${summary}” will do`}
        onPress={() => setOpen(!open)}
        style={s.toggle}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} color={colors.warnText} size={16} />
        <Text style={[styles.label, { color: colors.warnText }]}>
          {open ? 'Hide details' : 'What will happen'}
        </Text>
      </Pressable>
      {open && (
        <View style={s.preview}>
          <ApprovalPreview approval={approval} />
        </View>
      )}
      <View style={[styles.row, narrow && { alignSelf: 'stretch' }]}>
        <Button
          title="Approve"
          icon="check"
          accessibilityLabel={`Approve: ${summary}`}
          onPress={() => run(true)}
          busy={deciding && decide.variables?.approve === true}
          disabled={deciding}
          fullWidth={narrow}
        />
        <Button
          title="Reject"
          variant="secondary"
          accessibilityLabel={`Reject: ${summary}`}
          onPress={() => run(false)}
          disabled={deciding}
          fullWidth={narrow}
        />
      </View>
    </View>
  );
}

/**
 * Everything waiting for this person, from any command or entity action. Wide screens show
 * it above the content; phones dock it at the bottom, collapsed, within thumb reach.
 */
export function ApprovalCard({ variant = 'stack' }: { variant?: 'stack' | 'dock' }) {
  const { approvals: all } = useApprovals();
  const shownInline = useSyncExternalStore(subscribe, snapshot, snapshot).split(',');
  const approvals = all.filter((a) => !shownInline.includes(a.id));
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;
  const heading =
    approvals.length === 1
      ? '1 request waiting for your approval'
      : `${approvals.length} requests waiting for your approval`;

  if (variant === 'dock') {
    return (
      <View style={s.dock}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={s.dockBar}
        >
          <Icon name="alert-circle" color={colors.warnText} />
          <Text style={[styles.heading, { color: colors.warnText, flex: 1 }]}>{heading}</Text>
          <Icon name={open ? 'chevron-down' : 'chevron-up'} color={colors.warnText} />
        </Pressable>
        {open && (
          <ScrollView
            style={{ maxHeight: 420 }}
            contentContainerStyle={{ gap: space.lg, padding: space.lg, paddingTop: 0 }}
          >
            {approvals.map((a) => (
              <ApprovalItem key={a.id} approval={a} />
            ))}
          </ScrollView>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.card, s.card]} accessibilityRole="summary">
      <View style={styles.row}>
        <Icon name="alert-circle" color={colors.warnText} />
        <Text style={[styles.heading, { color: colors.warnText }]}>{heading}</Text>
      </View>
      {approvals.map((a) => (
        <ApprovalItem key={a.id} approval={a} />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, gap: space.lg },
  item: { gap: space.sm },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 32,
    alignSelf: 'flex-start',
  },
  preview: {
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.warnBorder,
    padding: space.md,
  },
  dock: { backgroundColor: colors.warnBg, borderTopWidth: 1, borderColor: colors.warnBorder },
  dockBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 52,
    paddingHorizontal: space.lg,
  },
});
