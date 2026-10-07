import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { TodoRow } from '../components/Rows';
import { ScreenTitle } from '../components/ScreenTitle';
import { useScreenContext } from '../framework/assistant-context';
import { DateField } from '../framework/DateField';
import { isValidDate, todayLocal } from '../framework/dates';
import { EmptyState, LoadError } from '../framework/EmptyState';
import { Field } from '../framework/Field';
import { type Chip, FilterChips } from '../framework/FilterChips';
import { errorMessage, useEntityList, useEntityMutation } from '../framework/hooks';
import { listRow, space, styles } from '../theme';

const chips = (): Chip[] => [
  { label: 'Open', query: { done: false, sort: 'dueOn' } },
  { label: 'Overdue', query: { done: false, dueOn: { lt: todayLocal() }, sort: 'dueOn' } },
  { label: 'Done', query: { done: true, sort: '-createdAt' } },
  { label: 'All', query: { sort: 'dueOn' } },
];

const empty: Record<string, { title: string; body?: string }> = {
  Open: {
    title: 'Nothing open',
    body: 'Add a to-do above, or close a meeting to turn its action items into to-dos.',
  },
  Overdue: { title: 'Nothing overdue' },
  Done: { title: 'Nothing done yet', body: 'Tick a to-do and it moves here.' },
  All: { title: 'No to-dos yet', body: 'Add one above.' },
};

export default function Todos() {
  useScreenContext({ screen: 'todos' });
  const options = chips();
  const [chip, setChip] = useState(options[0]);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const { create } = useEntityMutation('todos');
  const list = useEntityList('todos', chip.query);
  const count = list.items.length;
  const canAdd = title.trim() && (dueOn === '' || isValidDate(dueOn));

  const add = async () => {
    if (!canAdd) return;
    await create.mutateAsync({ title: title.trim(), ...(dueOn ? { dueOn } : {}) });
    setTitle('');
    setDueOn('');
  };

  return (
    <FlatList
      contentContainerStyle={[styles.content, { gap: 0 }]}
      data={list.items}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View style={{ gap: space.lg, marginBottom: space.lg }}>
          <ScreenTitle title="To-dos" />
          <View style={[styles.card, { gap: space.md }]}>
            <View style={[styles.row, { flexWrap: 'wrap', alignItems: 'flex-end' }]}>
              <Field
                label="New to-do"
                placeholder="Call the plumber"
                value={title}
                onChangeText={setTitle}
                onSubmitEditing={add}
              />
              <DateField label="Due" optional value={dueOn} onChange={setDueOn} />
              <Button
                title="Add"
                icon="plus"
                onPress={add}
                busy={create.isPending}
                disabled={!canAdd}
              />
            </View>
            {create.error && <Text style={styles.error}>{errorMessage(create.error)}</Text>}
          </View>
          <FilterChips chips={options} selected={chip.label} onSelect={setChip} />
        </View>
      }
      renderItem={({ item, index }) => (
        <View style={listRow(index, count)}>
          <TodoRow todo={item} />
        </View>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="to-dos" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState
            icon="check-square"
            title={empty[chip.label].title}
            body={empty[chip.label].body}
          />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
