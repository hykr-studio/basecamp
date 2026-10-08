import type { Approval } from '@app/contracts';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Button } from '../components/Button';
import { colors, space, styles } from '../theme';
import { ApprovalPreview, labelOf } from './ApprovalPreview';
import { AssistantMark } from './AssistantMark';
import { expiresIn } from './dates';
import { errorMessage, useApprovals } from './hooks';
import { Icon } from './Icon';
import { useT } from './lang';
import { useToast } from './Toast';
import { verbOf } from './verbs';

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

/**
 * The decision named for what it does: "Delete to-do", "Apply change to note", or for a
 * command its own verb ("Approve close"), from the command's spec.
 */
function actionLabel(a: Approval): string {
  const noun = labelOf(a.resourceType);
  const verb = verbOf(a.action);
  if (!verb.entityAction) return `Approve ${verb.do}`;
  const last = a.action.split('.').pop();
  if (last === 'delete') return `Delete ${noun}`;
  if (last === 'create') return `Create ${noun}`;
  return `Apply change to ${noun}`;
}

/** How long a newly shown decision ignores clicks, so a double-click can't land on it. */
const ARM_MS = 600;

/** One parked operation: what it is, who asked and why it waits, exactly what it will do, and the decision. */
export function ApprovalItem({
  approval,
  defaultOpen,
}: {
  approval: Approval;
  defaultOpen?: boolean;
}) {
  const { decide } = useApprovals();
  const toast = useToast();
  const { t } = useT();
  const narrow = useWindowDimensions().width < 600;
  const destructive = approval.action.endsWith('.delete');
  // A delete shows what goes, unasked: the riskier the decision, the less it hides.
  const [open, setOpen] = useState(defaultOpen ?? destructive);
  const summary = approval.summary ?? approval.action;
  const deciding = decide.isPending && decide.variables?.id === approval.id;
  const confirm = actionLabel(approval);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, []);

  // A double-click's second press arrives before the button re-renders as busy: ignore it here.
  const inFlight = useRef(false);
  async function run(approve: boolean) {
    if (!armed || inFlight.current) return;
    inFlight.current = true;
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
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <View style={s.item}>
      <View style={{ gap: 2 }}>
        <Text style={[styles.text, { fontWeight: '600' }]}>{summary}</Text>
        <View style={[styles.row, { gap: space.xs }]}>
          {approval.requestedBy === 'agent' && <AssistantMark size={16} />}
          <Text
            style={[
              styles.muted,
              { color: approval.requestedBy === 'agent' ? colors.assistant : colors.approvalText },
            ]}
          >
            {approval.requestedBy === 'agent' ? t('approval.askedBy') : t('approval.askedByYou')} ·{' '}
            {expiresIn(approval.expiresAt)}
          </Text>
        </View>
        <Text style={styles.muted}>Why it waits: {approval.reason}.</Text>
        {destructive && !open && (
          <Text style={[styles.muted, { color: colors.danger, fontWeight: '600' }]}>
            Approving deletes it permanently.
          </Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Hide' : 'Show'} what approving “${summary}” will do`}
        onPress={() => setOpen(!open)}
        style={s.toggle}
      >
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          color={colors.approvalText}
          size={16}
        />
        <Text style={[styles.label, { color: colors.approvalText }]}>
          {open ? 'Hide details' : 'What will happen'}
        </Text>
      </Pressable>
      {open && (
        <View style={[s.preview, destructive && { borderColor: colors.dangerTint }]}>
          <ApprovalPreview approval={approval} />
        </View>
      )}
      <View
        style={[
          styles.row,
          narrow && { alignSelf: 'stretch' },
          // On a phone, the safe choice takes the first slot and the delete sits apart from it.
          narrow && destructive && { flexDirection: 'row-reverse' },
        ]}
      >
        <Button
          title={confirm}
          variant={destructive ? 'destructive' : 'primary'}
          icon={destructive ? 'trash-2' : 'check'}
          accessibilityLabel={
            destructive
              ? `${confirm}: ${summary.replace(/^Delete /, '')}`
              : `${confirm}: ${summary}`
          }
          onPress={() => run(true)}
          busy={deciding && decide.variables?.approve === true}
          disabled={deciding}
          fullWidth={narrow}
        />
        <Button
          title={destructive ? t('approval.keep') : t('approval.reject')}
          variant="secondary"
          accessibilityLabel={`${destructive ? t('approval.keep') : t('approval.reject')}: ${summary}`}
          onPress={() => run(false)}
          disabled={deciding}
          fullWidth={narrow}
        />
      </View>
    </View>
  );
}

const LIMIT = 2;

/**
 * Everything waiting for this person, on its own calm surface (yellow stays for warnings).
 * Wide screens show it above the content; phones dock it at the bottom within thumb reach.
 * When the screen already shows a request inline, the rest shrink to one line.
 */
export function ApprovalCard({
  variant = 'stack',
  hidden = false,
}: {
  variant?: 'stack' | 'dock';
  hidden?: boolean;
}) {
  const { approvals: all } = useApprovals();
  const shown = useSyncExternalStore(subscribe, snapshot, snapshot);
  const shownInline = shown ? shown.split(',') : [];
  const approvals = all.filter((a) => !shownInline.includes(a.id));
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Once everything is decided, the next request starts folded again.
  const none = approvals.length === 0;
  useEffect(() => {
    if (none) setOpen(false);
  }, [none]);
  if (approvals.length === 0 || hidden) return null;
  const count = approvals.length;
  const heading = shownInline.length
    ? `${count} other request${count === 1 ? '' : 's'} waiting for your decision`
    : `${count} request${count === 1 ? '' : 's'} waiting for your decision`;
  // Folded by default on every screen size: the page keeps its own focus, and nothing
  // expands on its own (so a request never appears under the cursor after another decision).
  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: false }}
        accessibilityLabel={`${heading}. Review`}
        onPress={() => setOpen(true)}
        style={variant === 'dock' ? s.dockBar : [s.bar, styles.card]}
      >
        <Icon name="inbox" color={colors.approvalText} />
        <Text style={[styles.label, { color: colors.approvalText, flex: 1 }]}>{heading}</Text>
        <Text style={[styles.label, { color: colors.primary }]}>Review</Text>
        <Icon name={variant === 'dock' ? 'chevron-up' : 'chevron-down'} color={colors.primary} />
      </Pressable>
    );
  }

  const visible = showAll ? approvals : approvals.slice(0, LIMIT);
  const body = (
    <>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <View style={styles.row}>
          <Icon name="inbox" color={colors.approvalText} />
          <Text style={[styles.heading, { color: colors.approvalText }]}>{heading}</Text>
        </View>
        <Button title="Hide" variant="subtle" onPress={() => setOpen(false)} />
      </View>
      {visible.map((a, i) => (
        <View key={a.id} style={i > 0 ? s.divider : undefined}>
          {/* The dock keeps the decision within reach: details start folded there. */}
          <ApprovalItem approval={a} defaultOpen={variant === 'dock' ? false : undefined} />
        </View>
      ))}
      {count > LIMIT && (
        <Button
          title={showAll ? 'Show fewer' : `Show all ${count}`}
          variant="subtle"
          onPress={() => setShowAll(!showAll)}
        />
      )}
    </>
  );

  if (variant === 'dock') {
    return (
      <View style={s.dock}>
        <ScrollView
          style={{ maxHeight: 420 }}
          contentContainerStyle={{ gap: space.lg, padding: space.lg }}
        >
          {body}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={[styles.card, s.card]} accessibilityRole="summary">
      {body}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.approvalBg, borderColor: colors.approvalBorder, gap: space.lg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 52,
    paddingVertical: space.sm,
    backgroundColor: colors.approvalBg,
    borderColor: colors.approvalBorder,
  },
  item: { gap: space.sm },
  divider: { borderTopWidth: 1, borderColor: colors.approvalBorder, paddingTop: space.lg },
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
    borderColor: colors.approvalBorder,
    padding: space.md,
  },
  dock: {
    backgroundColor: colors.approvalBg,
    borderTopWidth: 1,
    borderColor: colors.approvalBorder,
  },
  dockBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 52,
    paddingHorizontal: space.lg,
    backgroundColor: colors.approvalBg,
    borderTopWidth: 1,
    borderColor: colors.approvalBorder,
  },
});
