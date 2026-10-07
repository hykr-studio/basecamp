import { useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { TodoRow } from '../../components/Rows';
import { useScreenContext } from '../../framework/assistant-context';
import { todayLocal } from '../../framework/dates';
import { type Chip, FilterChips } from '../../framework/FilterChips';
import { errorMessage, useEntityList, useEntityMutation } from '../../framework/hooks';
import { colors, styles } from '../../theme';

const chips = (): Chip[] => [
  { label: 'Open', query: { done: false } },
  { label: 'Done', query: { done: true } },
  { label: 'Overdue', query: { done: false, dueOn: { lt: todayLocal() } } },
  { label: 'All', query: {} },
];

export default function Todos() {
  useScreenContext({ screen: 'todos' });
  const options = chips();
  const [chip, setChip] = useState(options[0]);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const { create } = useEntityMutation('todos');
  const list = useEntityList('todos', { ...chip.query, sort: 'dueOn' });

  const add = async () => {
    if (!title.trim()) return;
    await create.mutateAsync({ title: title.trim(), ...(dueOn ? { dueOn } : {}) });
    setTitle('');
    setDueOn('');
  };

  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            <TextInput
              style={[styles.input, { flex: 1, minWidth: 180 }]}
              placeholder="Add a to-do"
              placeholderTextColor={colors.muted}
              value={title}
              onChangeText={setTitle}
              onSubmitEditing={add}
            />
            <TextInput
              style={[styles.input, { width: 150 }]}
              placeholder="Due (YYYY-MM-DD)"
              placeholderTextColor={colors.muted}
              value={dueOn}
              onChangeText={setDueOn}
            />
            <Button title="Add" onPress={add} busy={create.isPending} disabled={!title.trim()} />
          </View>
          {create.error && <Text style={styles.error}>{errorMessage(create.error)}</Text>}
          <FilterChips chips={options} selected={chip.label} onSelect={setChip} />
        </View>
      }
      renderItem={({ item }) => <TodoRow todo={item} />}
      ListEmptyComponent={!list.loading ? <Text style={styles.muted}>Nothing here.</Text> : null}
      onEndReached={list.loadMore}
    />
  );
}
