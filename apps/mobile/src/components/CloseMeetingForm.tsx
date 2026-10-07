import { type CloseMeetingInput, CloseMeetingSpec, type MeetingView } from '@app/contracts';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useAssistant } from '../framework/assistant-context';
import { errorMessage, useApprovals, useCommand } from '../framework/hooks';
import { colors, styles } from '../theme';
import { Button } from './Button';

type Item = { title: string; dueOn: string };

/** Close by hand (runs at once), or draft from pasted notes with the assistant (parked for approval). */
export function CloseMeetingForm({
  meeting,
  onDone,
}: {
  meeting: MeetingView;
  onDone: () => void;
}) {
  const close = useCommand(CloseMeetingSpec);
  const assistant = useAssistant();
  const { approvals } = useApprovals();
  const [summary, setSummary] = useState('');
  const [decisions, setDecisions] = useState<string[]>(['']);
  const [items, setItems] = useState<Item[]>([{ title: '', dueOn: '' }]);
  const [pasted, setPasted] = useState('');
  const [drafting, setDrafting] = useState(false);

  // A close the assistant parked for this meeting: show exactly what it would write.
  const parked = approvals.find(
    (a) => a.action === 'meeting.close' && a.resourceId === meeting.id && a.status === 'pending',
  );
  const parkedInput = parked?.input as CloseMeetingInput | undefined;
  useEffect(() => {
    if (!parkedInput) return;
    setSummary(parkedInput.summary);
    setDecisions(parkedInput.decisions?.length ? parkedInput.decisions : ['']);
    setItems(
      (parkedInput.actionItems ?? []).map((i) => ({ title: i.title, dueOn: i.dueOn ?? '' })),
    );
  }, [parkedInput]);

  const field = (value: string, onChange: (v: string) => void, placeholder: string, extra = {}) => (
    <TextInput
      style={[styles.input, { flex: 1 }, extra]}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      accessibilityLabel={placeholder}
      editable={!parked}
      // Pasted notes keep their line breaks: each "- " line is an action item.
      multiline={placeholder === 'Summary' || placeholder === 'Paste meeting notes'}
    />
  );

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Close meeting</Text>
      {parked ? (
        <Text style={styles.muted}>
          The assistant drafted this close. Read it, then approve or reject it in the card at the
          top.
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          {field(pasted, setPasted, 'Paste meeting notes', {
            minHeight: 90,
            textAlignVertical: 'top',
          })}
          <Button
            title="Draft from notes"
            variant="ghost"
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
      )}

      {field(summary, setSummary, 'Summary', { minHeight: 60, textAlignVertical: 'top' })}

      <Text style={styles.muted}>Decisions</Text>
      {decisions.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: editable rows in order
        <View key={i} style={styles.row}>
          {field(
            d,
            (v) => setDecisions(decisions.map((x, j) => (j === i ? v : x))),
            `Decision ${i + 1}`,
          )}
          {!parked && (
            <Button
              title="−"
              variant="ghost"
              onPress={() => setDecisions(decisions.filter((_, j) => j !== i))}
            />
          )}
        </View>
      ))}
      {!parked && (
        <Button
          title="Add decision"
          variant="ghost"
          onPress={() => setDecisions([...decisions, ''])}
        />
      )}

      <Text style={styles.muted}>Action items (each becomes a to-do on this meeting)</Text>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: editable rows in order
        <View key={i} style={styles.row}>
          {field(
            item.title,
            (v) => setItems(items.map((x, j) => (j === i ? { ...x, title: v } : x))),
            `Action item ${i + 1}`,
          )}
          <TextInput
            style={[styles.input, { width: 130 }]}
            value={item.dueOn}
            onChangeText={(v) => setItems(items.map((x, j) => (j === i ? { ...x, dueOn: v } : x)))}
            placeholder="Due (optional)"
            placeholderTextColor={colors.muted}
            editable={!parked}
          />
          {!parked && (
            <Button
              title="−"
              variant="ghost"
              onPress={() => setItems(items.filter((_, j) => j !== i))}
            />
          )}
        </View>
      ))}
      {!parked && (
        <Button
          title="Add action item"
          variant="ghost"
          onPress={() => setItems([...items, { title: '', dueOn: '' }])}
        />
      )}

      {close.error && <Text style={styles.error}>{errorMessage(close.error)}</Text>}
      {!parked && (
        <View style={styles.row}>
          <Button
            title="Close meeting"
            busy={close.isPending}
            disabled={!summary.trim()}
            onPress={async () => {
              const result = await close.mutateAsync({
                meetingId: meeting.id,
                summary: summary.trim(),
                decisions: decisions.map((d) => d.trim()).filter(Boolean),
                actionItems: items
                  .filter((i) => i.title.trim())
                  .map((i) => ({ title: i.title.trim(), ...(i.dueOn ? { dueOn: i.dueOn } : {}) })),
              });
              if (result.status === 'done') onDone();
            }}
          />
          <Button title="Cancel" variant="ghost" onPress={onDone} />
        </View>
      )}
    </View>
  );
}
