import { type Approval, type Todo, TodoSpec } from '@app/contracts';
import { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { api, errorMessage, type SessionUser } from '../api';
import { Approvals } from '../components/Approvals';
import { Button } from '../components/Button';
import { Chat } from '../components/Chat';
import { colors, styles } from '../theme';

const todosApi = api.entity(TodoSpec);

type Props = { user: SessionUser; onSignOut: () => void };

export function Todos({ user, onSignOut }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wide = useWindowDimensions().width >= 900;

  const refresh = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([
        todosApi.list().then((page) => page.items),
        api.listApprovals(),
      ]);
      setTodos(t);
      setApprovals(a);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Run one change, show its error if any, then reload what the server has. */
  async function act(id: string | null, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }

  async function add() {
    const value = title.trim();
    if (!value) return;
    setAdding(true);
    await act(null, () => todosApi.create({ title: value }));
    setTitle('');
    setAdding(false);
  }

  const list = (
    <View style={[styles.card, wide && { flex: 1 }]}>
      <Text style={styles.heading}>To-dos</Text>
      <View style={styles.row}>
        <TextInput
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
          placeholder="Add a to-do"
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={add}
        />
        <Button title="Add" onPress={add} busy={adding} disabled={!title.trim()} />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {todos.length === 0 ? (
        <Text style={styles.muted}>Nothing yet.</Text>
      ) : (
        todos.map((t) => (
          <View key={t.id} style={s.todo}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: t.done, busy: busyId === t.id }}
              accessibilityLabel={t.title}
              onPress={() => act(t.id, () => todosApi.update(t.id, { done: !t.done }))}
              style={s.toggle}
            >
              <View style={[s.box, t.done && s.boxDone]}>
                {t.done && <Text style={s.tick}>✓</Text>}
              </View>
              <Text style={[styles.text, t.done && s.doneText]}>{t.title}</Text>
              {t.dueOn && <Text style={styles.muted}>due {t.dueOn}</Text>}
            </Pressable>
            <Button
              title="Delete"
              variant="danger"
              onPress={() => act(t.id, () => todosApi.remove(t.id))}
              busy={busyId === t.id}
            />
          </View>
        ))
      )}
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.title}>Hi, {user.name}</Text>
        <Button title="Sign out" variant="ghost" onPress={onSignOut} />
      </View>
      <Approvals
        approvals={approvals}
        busyId={busyId}
        onDecide={(id, approve) => act(id, () => api.decideApproval(id, approve))}
      />
      <View style={wide ? s.columns : { gap: 16 }}>
        {list}
        <View style={wide ? { width: 400 } : undefined}>
          <Chat onToolUse={refresh} />
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  columns: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  todo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: colors.primaryText, fontSize: 14, fontWeight: '700' },
  doneText: { color: colors.muted, textDecorationLine: 'line-through' },
});
