import { CloseMeetingSpec, type MeetingView } from '@app/contracts';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApprovalItem, useShownInline } from '../framework/ApprovalCard';
import { useAssistant } from '../framework/assistant-context';
import { DateField } from '../framework/DateField';
import { Field } from '../framework/Field';
import { errorMessage, useApprovals, useCommand } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { useToast } from '../framework/Toast';
import { colors, space, styles } from '../theme';
import { Button } from './Button';

type Item = { title: string; dueOn: string };

/**
 * Two ways to close, one at a time: draft from pasted notes with the assistant (parked for
 * your approval, decided right here), or write it yourself (runs at once).
 */
export function CloseMeetingForm({
  meeting,
  onDone,
}: {
  meeting: MeetingView;
  onDone: () => void;
}) {
  const close = useCommand(CloseMeetingSpec);
  const assistant = useAssistant();
  const toast = useToast();
  const { approvals } = useApprovals();
  const [mode, setMode] = useState<'draft' | 'write'>('draft');
  const [pasted, setPasted] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [summary, setSummary] = useState('');
  const [decisions, setDecisions] = useState<string[]>(['']);
  const [items, setItems] = useState<Item[]>([{ title: '', dueOn: '' }]);

  const parked = approvals.find(
    (a) => a.action === 'meeting.close' && a.resourceId === meeting.id && a.status === 'pending',
  );
  // Decided here, so the global card leaves it out.
  useShownInline(parked?.id);
  // When the draft appears, move focus to it: it is what the person came here to decide.
  const draftRef = useRef<View>(null);
  useEffect(() => {
    if (parked) (draftRef.current as unknown as { focus?: () => void } | null)?.focus?.();
  }, [parked]);

  if (parked) {
    return (
      <View
        ref={draftRef}
        focusable
        accessibilityLabel={`The assistant drafted this close: ${parked.summary ?? ''}`}
        style={[styles.card, s.parked]}
      >
        <View style={styles.row}>
          <Icon name="clock" color={colors.approvalText} />
          <Text style={[styles.heading, { color: colors.approvalText }]}>
            The assistant drafted this close
          </Text>
        </View>
        <Text style={[styles.muted, { color: colors.approvalText }]}>
          Read exactly what it will write, then approve it or reject it. Nothing is written until
          you approve.
        </Text>
        <ApprovalItem approval={parked} defaultOpen />
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.heading}>Close meeting</Text>
        <Button title="Cancel" variant="subtle" onPress={onDone} />
      </View>
      <View style={s.segment} accessibilityRole="tablist">
        {(['draft', 'write'] as const).map((m) => (
          <Pressable
            key={m}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === m }}
            nativeID={`close-tab-${m}`}
            {...({ 'aria-controls': 'close-panel' } as object)}
            onPress={() => setMode(m)}
            style={[s.segmentItem, mode === m && s.segmentOn]}
          >
            <Text style={[styles.label, { color: mode === m ? colors.primary : colors.muted }]}>
              {m === 'draft' ? 'Draft from notes' : 'Write it yourself'}
            </Text>
          </Pressable>
        ))}
      </View>

      <View
        nativeID="close-panel"
        role="tabpanel"
        {...({ 'aria-labelledby': `close-tab-${mode}` } as object)}
      >
        {mode === 'draft' ? (
          <View style={{ gap: space.md }}>
            <Field
              label="Meeting notes"
              hint='Paste them as written. Lines starting with "- " become action items.'
              value={pasted}
              onChangeText={setPasted}
              multiline
              multilineHeight={140}
              placeholder={
                'e.g. We agreed on the tile supplier.\n- Order tiles\n- Call the plumber'
              }
            />
            <View style={styles.row}>
              <Button
                title="Draft with the assistant"
                icon="message-circle"
                busy={drafting}
                disabled={!pasted.trim()}
                onPress={async () => {
                  setDrafting(true);
                  // The meeting is named and is also the chat's context, so "close this one" works too.
                  await assistant.send(`close ${meeting.title}\n${pasted.trim()}`);
                  setDrafting(false);
                }}
              />
            </View>
            <Text style={styles.muted}>
              The draft waits for your approval here before anything is written.
            </Text>
          </View>
        ) : (
          <View style={{ gap: space.lg }}>
            <Field
              label="Summary"
              value={summary}
              onChangeText={setSummary}
              multiline
              multilineHeight={72}
              placeholder="e.g. Two or three sentences"
            />
            <View style={styles.section}>
              <Text style={styles.label}>Decisions</Text>
              {decisions.map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: editable rows in order
                <View key={i} style={[styles.row, { alignItems: 'flex-end' }]}>
                  <Field
                    label={`Decision ${i + 1}`}
                    value={d}
                    onChangeText={(v) => setDecisions(decisions.map((x, j) => (j === i ? v : x)))}
                  />
                  <Button
                    title={`Remove decision ${i + 1}`}
                    icon="x"
                    iconOnly
                    variant="subtle"
                    onPress={() => setDecisions(decisions.filter((_, j) => j !== i))}
                  />
                </View>
              ))}
              <Button
                title="Add a decision"
                icon="plus"
                variant="subtle"
                onPress={() => setDecisions([...decisions, ''])}
              />
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>Action items</Text>
              <Text style={styles.muted}>Each becomes a to-do on this meeting.</Text>
              {items.map((item, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: editable rows in order
                <View key={i} style={[styles.row, { flexWrap: 'wrap', alignItems: 'flex-end' }]}>
                  <Field
                    label={`Action item ${i + 1}`}
                    value={item.title}
                    onChangeText={(v) =>
                      setItems(items.map((x, j) => (j === i ? { ...x, title: v } : x)))
                    }
                    placeholder="e.g. Starts with a verb: Order tiles"
                  />
                  <DateField
                    label="Due"
                    optional
                    value={item.dueOn}
                    onChange={(v) =>
                      setItems(items.map((x, j) => (j === i ? { ...x, dueOn: v } : x)))
                    }
                  />
                  <Button
                    title={`Remove action item ${i + 1}`}
                    icon="x"
                    iconOnly
                    variant="subtle"
                    onPress={() => setItems(items.filter((_, j) => j !== i))}
                  />
                </View>
              ))}
              <Button
                title="Add an action item"
                icon="plus"
                variant="subtle"
                onPress={() => setItems([...items, { title: '', dueOn: '' }])}
              />
            </View>
            {close.error && <Text style={styles.error}>{errorMessage(close.error)}</Text>}
            <View style={styles.row}>
              <Button
                title="Close meeting"
                busy={close.isPending}
                disabled={!summary.trim()}
                onPress={async () => {
                  const actionItems = items
                    .filter((i) => i.title.trim())
                    .map((i) => ({
                      title: i.title.trim(),
                      ...(i.dueOn ? { dueOn: i.dueOn } : {}),
                    }));
                  const result = await close.mutateAsync({
                    meetingId: meeting.id,
                    summary: summary.trim(),
                    decisions: decisions.map((d) => d.trim()).filter(Boolean),
                    actionItems,
                  });
                  if (result.status === 'done') {
                    toast.show({
                      tone: 'success',
                      message: `Closed ${meeting.title}: 1 note and ${actionItems.length} to-do${actionItems.length === 1 ? '' : 's'} created`,
                    });
                    onDone();
                  }
                }}
              />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  parked: { backgroundColor: colors.approvalBg, borderColor: colors.approvalBorder },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: 10,
    padding: 3,
    alignSelf: 'flex-start',
  },
  segmentItem: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: 8,
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
});
