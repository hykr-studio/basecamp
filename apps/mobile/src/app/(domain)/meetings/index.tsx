import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Button } from '../../../components/Button';
import { ScreenTitle } from '../../../components/ScreenTitle';
import { MeetingRow } from '../../../domain/components/Rows';
import { useScreenContext } from '../../../framework/assistant-context';
import { DateField, TimeField } from '../../../framework/DateField';
import { at, isValidDate, isValidTime, todayLocal } from '../../../framework/dates';
import { EmptyState, LoadError } from '../../../framework/EmptyState';
import { Field } from '../../../framework/Field';
import { type Chip, FilterChips, SearchBox } from '../../../framework/FilterChips';
import { errorMessage, useEntityList, useEntityMutation } from '../../../framework/hooks';
import { useToast } from '../../../framework/Toast';
import { listRow, space, styles } from '../../../theme';

const chips = (): Chip[] => {
  const now = new Date().toISOString();
  return [
    { label: 'All', query: { sort: '-startsAt' } },
    { label: 'Upcoming', query: { status: 'scheduled', startsAt: { gte: now }, sort: 'startsAt' } },
    {
      label: 'Needs closing',
      query: { status: { in: ['scheduled', 'held'] }, startsAt: { lt: now }, sort: '-startsAt' },
    },
    { label: 'Closed', query: { status: 'closed', sort: '-startsAt' } },
  ];
};

/**
 * A new meeting starts at the next full hour, so it is not born "Needs closing"; after the
 * working day (from 18:00) it moves to tomorrow at 10:00.
 */
function nextSlot(now = new Date()): { date: string; time: string } {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  if (now.getHours() >= 18 || next.getDate() !== now.getDate()) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return { date: tomorrow.toLocaleDateString('sv'), time: '10:00' };
  }
  return { date: todayLocal(), time: `${String(next.getHours()).padStart(2, '0')}:00` };
}

function NewMeeting({ onDone }: { onDone: () => void }) {
  const { create } = useEntityMutation('meetings');
  const toast = useToast();
  const [slot] = useState(nextSlot);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(slot.date);
  const [time, setTime] = useState(slot.time);
  const [minutes, setMinutes] = useState('60');
  const [attendees, setAttendees] = useState('');
  const valid = title.trim() && isValidDate(date) && isValidTime(time) && Number(minutes) > 0;
  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.heading}>New meeting</Text>
        <Button title="Cancel" variant="subtle" onPress={onDone} />
      </View>
      <Field
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Site review"
        autoFocus
      />
      <View style={[styles.row, { flexWrap: 'wrap', alignItems: 'flex-start' }]}>
        <DateField label="Date" value={date} onChange={setDate} />
        <TimeField label="Starts" value={time} onChange={setTime} />
        <Field
          label="Minutes"
          value={minutes}
          onChangeText={setMinutes}
          keyboardType="number-pad"
          width={100}
        />
      </View>
      <Field
        label="Attendees (optional)"
        hint="Separate names with commas."
        value={attendees}
        onChangeText={setAttendees}
        placeholder="e.g. Ravi, Asha"
      />
      {create.error && <Text style={styles.error}>{errorMessage(create.error)}</Text>}
      <View style={styles.row}>
        <Button
          title="Create meeting"
          busy={create.isPending}
          disabled={!valid}
          onPress={async () => {
            const startsAt = at(date, time);
            await create.mutateAsync({
              title: title.trim(),
              startsAt,
              endsAt: new Date(
                new Date(startsAt).getTime() + Number(minutes) * 60_000,
              ).toISOString(),
              attendees: attendees
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
            });
            toast.show({ tone: 'success', message: `Created ${title.trim()}` });
            onDone();
          }}
        />
      </View>
    </View>
  );
}

/** Upcoming, past and closed meetings: filter, search, scroll by cursor. */
export default function Meetings() {
  useScreenContext({ screen: 'meetings' });
  const params = useLocalSearchParams<{ new?: string }>();
  const options = chips();
  const [chip, setChip] = useState(options[0]);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(params.new === '1');
  const list = useEntityList('meetings', {
    ...chip.query,
    ...(q.trim() ? { q: q.trim() } : {}),
    limit: 25,
  });
  const count = list.items.length;

  return (
    <FlatList
      contentContainerStyle={[styles.content, { gap: 0 }]}
      data={list.items}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={
        <View style={{ gap: space.lg, marginBottom: space.lg }}>
          <ScreenTitle
            title="Meetings"
            action={
              !adding && <Button title="New meeting" icon="plus" onPress={() => setAdding(true)} />
            }
          />
          {adding && <NewMeeting onDone={() => setAdding(false)} />}
          <View style={{ gap: space.md }}>
            <SearchBox value={q} onChange={setQ} placeholder="e.g. Search meetings" />
            <FilterChips chips={options} selected={chip.label} onSelect={setChip} />
          </View>
        </View>
      }
      renderItem={({ item, index }) => (
        <View style={listRow(index, count)}>
          <MeetingRow meeting={item} />
        </View>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="meetings" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState
            icon="calendar"
            title={
              q.trim()
                ? `No meetings match “${q.trim()}”`
                : chip.label === 'Needs closing'
                  ? 'Nothing to close'
                  : 'No meetings here'
            }
            body={
              chip.label === 'Needs closing'
                ? 'Every past meeting has its summary and to-dos.'
                : undefined
            }
            action={
              !q.trim() && chip.label !== 'Needs closing'
                ? { label: 'Plan a meeting', onPress: () => setAdding(true) }
                : undefined
            }
          />
        )
      }
      ListFooterComponent={
        list.hasMore ? (
          <View style={{ marginTop: space.md, flexDirection: 'row' }}>
            <Button title="Load more" variant="secondary" onPress={list.loadMore} />
          </View>
        ) : null
      }
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
    />
  );
}
