import type { Todo } from '@app/contracts';
import type { TodoItemView, TodoListView } from '@app/ui-registry';
import type { ViewProps } from '@app/ui-registry/react';
import { View } from 'react-native';
import { Checkbox } from '@/components/ui/checkbox';
import { Text } from '@/components/ui/text';
import { relativeDay } from '../../framework/dates';
import { ByAssistant, Rows, ViewCard } from '../../views/parts';

/** A to-do with its tick box: ticking runs todo.update as the person. */
function TodoLine({ todo, onToggle }: { todo: Todo; onToggle: () => void }) {
  const due = todo.dueOn && !todo.done ? relativeDay(todo.dueOn) : null;
  return (
    <View className="min-h-11 flex-row items-center gap-3 py-2">
      <Checkbox checked={todo.done} onCheckedChange={onToggle} accessibilityLabel={todo.title} />
      <View className="flex-1 gap-0.5">
        <Text className={todo.done ? 'text-muted line-through' : undefined}>{todo.title}</Text>
        {(due || todo.createdBy === 'assistant') && (
          <View className="flex-row flex-wrap items-center gap-x-3">
            {due && (
              <Text
                variant="muted"
                className={due.overdue ? 'font-semibold text-danger' : undefined}
              >
                {due.text}
              </Text>
            )}
            {todo.createdBy === 'assistant' && <ByAssistant />}
          </View>
        )}
      </View>
    </View>
  );
}

export function TodoListComponent({ title, items, act, words }: ViewProps<typeof TodoListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(t) => <TodoLine todo={t} onToggle={() => act('toggle', t)} />}
      </Rows>
    </ViewCard>
  );
}

export function TodoItemComponent({ item, act }: ViewProps<typeof TodoItemView>) {
  return (
    <ViewCard>
      <TodoLine todo={item} onToggle={() => act('toggle', item)} />
    </ViewCard>
  );
}
