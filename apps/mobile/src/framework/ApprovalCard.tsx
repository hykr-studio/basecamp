import type { Approval } from '@app/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { api } from '../api';
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
 * One place to decide each request. A screen that shows a request (the close form shows its
 * own draft) owns it; otherwise the chat card that brought it does; otherwise the global card.
 * Every other place that mentions it points to the owner instead of offering a second
 * Approve button, and the global card leaves owned requests out.
 */
type Owner = { token: symbol; kind: 'screen' | 'chat'; where?: string };
const owners = new Map<string, Owner[]>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => [...owners.keys()].sort().join(',');

/** The owner of a request: the first screen that shows it, else the first chat card. */
function ownerOf(id: string): Owner | undefined {
  const list = owners.get(id) ?? [];
  return list.find((o) => o.kind === 'screen') ?? list[0];
}

function useOwnership(id: string | undefined, kind: Owner['kind'], where?: string) {
  const [token] = useState(() => Symbol(kind));
  useEffect(() => {
    if (!id) return;
    const owner: Owner = { token, kind, where };
    owners.set(id, [...(owners.get(id) ?? []), owner]);
    emit();
    return () => {
      const rest = (owners.get(id) ?? []).filter((o) => o !== owner);
      if (rest.length) owners.set(id, rest);
      else owners.delete(id);
      emit();
    };
  }, [id, kind, where, token]);
  return token;
}

/**
 * Call from a screen that decides a request in place (it renders ApprovalItem itself), so
 * the global card and the chat point here instead. `where` names the place for the pointer:
 * "Waiting for you on Site review".
 */
export function useShownInline(id: string | undefined, where?: string) {
  useOwnership(id, 'screen', where);
}

/**
 * Call from a chat card that mentions a request: 'here' when it should offer the decision,
 * or where the decision lives instead (a screen, or an earlier card in the thread).
 */
export function useDecisionPlace(
  id: string | undefined,
): { here: true } | { here: false; where?: string; onScreen: boolean } {
  const token = useOwnership(id, 'chat');
  const owner = useSyncExternalStore(
    subscribe,
    () => (id ? ownerOf(id) : undefined),
    () => (id ? ownerOf(id) : undefined),
  );
  if (!owner || owner.token === token) return { here: true };
  return { here: false, where: owner.where, onScreen: owner.kind === 'screen' };
}

/**
 * Set by a chat that covers the screen (the phone sheet): how to step aside, so a pointer to
 * a decision on the screen can show it.
 */
export const LeaveChat = createContext<(() => void) | undefined>(undefined);

/** The element a request is decided in, for a pointer to scroll to (web). */
const anchorId = (id: string) => `approval-${id}`;

/** Bring the place a request is decided into view and put focus there (web; native: no-op). */
export function revealDecision(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(anchorId(id));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/**
 * What became of a request: pending while it is on the waiting list, then its final state
 * (fetched once it leaves the list). The chat's lines and cards all read it from here.
 */
export function useApprovalStatus(id: string | undefined) {
  const { approvals } = useApprovals();
  const pending = id ? approvals.find((a) => a.id === id) : undefined;
  const decided = useQuery({
    queryKey: ['approval', id],
    queryFn: () => api.getApproval(id as string),
    enabled: !!id && !pending,
    // A pending answer is never final: fetch again once it has left the waiting list.
    staleTime: 0,
  });
  const approval: Approval | undefined = pending ?? decided.data;
  return { approval, status: pending ? 'pending' : decided.data?.status };
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
    // The anchor a pointer elsewhere ("Waiting for you on …") scrolls to.
    <View style={s.item} nativeID={anchorId(approval.id)}>
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
    // A 44px target that still sits like a 32px line: the extra height overlaps the gaps.
    minHeight: 44,
    marginVertical: -6,
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
