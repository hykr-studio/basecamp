import { ClearDoneTodosSpec } from '@application/domain/contracts';
import {
  Button,
  type Chip,
  CustomFieldInputs,
  DateField,
  EmptyState,
  errorMessage,
  Field,
  FilterChips,
  ImportRecords,
  isValidDate,
  LoadError,
  listRow,
  ScreenTitle,
  space,
  styles,
  todayLocal,
  useCommand,
  useCustomFields,
  useEntityList,
  useEntityMutation,
  useFeature,
  useFieldLabel,
  useScreenContext,
} from '@hykr/app';
import { type CustomFieldsInput, customForCreate } from '@hykr/contracts';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { TodoRow } from '../components/TodoRow';

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

/**
 * All to-dos: add one (with the business's own fields, such as a priority), import many from a
 * file (people who may import), filter by open, overdue or done, and by a field the business
 * made filterable.
 */
export function Todos() {
  useScreenContext({ screen: 'todos' });
  const options = chips();
  const [chip, setChip] = useState(options[0]);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  // The business's fields (Settings → Custom fields): what the form collected, and a new `key`
  // after each add so the inputs start empty again.
  const fields = useCustomFields('todo');
  const label = useFieldLabel();
  const [custom, setCustom] = useState<CustomFieldsInput>({});
  const [form, setForm] = useState(0);
  // One choice per filterable list field (`custom[priority]=high`), or none.
  const [only, setOnly] = useState<Record<string, string>>({});
  const filters = fields.filter((f) => f.filterable && f.type === 'select');
  // Only fields the business still has as filterable: anything else would be a 400.
  const active = Object.fromEntries(
    Object.entries(only).filter(([k]) => filters.some((f) => f.key === k)),
  );
  const query = Object.keys(active).length ? { ...chip.query, custom: active } : chip.query;
  const { create } = useEntityMutation('todos');
  const list = useEntityList('todos', query);
  // Only when the business switched "clear done to-dos" on (Settings → Features).
  const canClear = useFeature('todos.clear-done');
  const clear = useCommand(ClearDoneTodosSpec);
  const count = list.items.length;
  const values = customForCreate(custom);
  const missing = fields.some((f) => f.required && values?.[f.key] === undefined);
  const canAdd = title.trim() && (dueOn === '' || isValidDate(dueOn)) && !missing;

  const add = async () => {
    if (!canAdd) return;
    await create.mutateAsync({
      title: title.trim(),
      ...(dueOn ? { dueOn } : {}),
      ...(values ? { custom: values } : {}),
    });
    setTitle('');
    setDueOn('');
    setCustom({});
    setForm((n) => n + 1);
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
                placeholder="e.g. Call the plumber"
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
            <CustomFieldInputs
              key={form}
              entity="todo"
              values={custom}
              onChange={(patch) => setCustom((c) => ({ ...c, ...patch }))}
            />
            {create.error && <Text style={styles.error}>{errorMessage(create.error)}</Text>}
          </View>
          {/* For people who may import (imports.run): to-dos from the old system's CSV export,
              keyed by its legacy_id, so importing it again updates them (import/todos.csv). */}
          <ImportRecords
            entity="todo"
            label="to-dos"
            options={{ key: 'legacy_id', source: 'legacy' }}
          />
          <View style={[styles.row, { flexWrap: 'wrap', justifyContent: 'space-between' }]}>
            <FilterChips chips={options} selected={chip.label} onSelect={setChip} />
            {canClear && chip.label === 'Done' && count > 0 ? (
              <Button
                title="Clear done"
                icon="trash-2"
                variant="secondary"
                busy={clear.isPending}
                onPress={() => clear.mutate({})}
              />
            ) : null}
          </View>
          {filters.map((f) => (
            <FilterChips
              key={f.key}
              chips={[
                { label: `Any ${label(f).toLowerCase()}`, query: {} },
                ...f.options.map((o) => ({ label: o, query: { [f.key]: o } })),
              ]}
              selected={only[f.key] ?? `Any ${label(f).toLowerCase()}`}
              onSelect={(c) =>
                setOnly(({ [f.key]: _was, ...rest }) =>
                  c.query[f.key] === undefined
                    ? rest
                    : { ...rest, [f.key]: String(c.query[f.key]) },
                )
              }
            />
          ))}
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
