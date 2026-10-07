import { useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { MeetingRow } from '../../components/Rows';
import { useScreenContext } from '../../framework/assistant-context';
import { at, todayLocal } from '../../framework/dates';
import { type Chip, FilterChips, SearchBox } from '../../framework/FilterChips';
import { errorMessage, useEntityList, useEntityMutation } from '../../framework/hooks';
import { colors, styles } from '../../theme';

const chips: Chip[] = [
  { label: 'All', query: {} },
  { label: 'Scheduled', query: { status: 'scheduled' } },
  { label: 'Held', query: { status: 'held' } },
  { label: 'Closed', query: { status: 'closed' } },
];

function NewMeeting({ onDone }: { onDone: () => void }) {
  const { create } = useEntityMutation('meetings');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [time, setTime] = useState('10:00');
  const [minutes, setMinutes] = useState('60');
  const [attendees, setAttendees] = useState('');
  const input = (value: string, set: (v: string) => void, placeholder: string, width?: number) => (
    <TextInput
      style={[styles.input, width ? { width } : { flex: 1 }]}
      value={value}
      onChangeText={set}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      accessibilityLabel={placeholder}
    />
  );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>New meeting</Text>
      {input(title, setTitle, 'Title')}
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        {input(date, setDate, 'Date (YYYY-MM-DD)', 150)}
        {input(time, setTime, 'Start (HH:MM)', 110)}
        {input(minutes, setMinutes, 'Minutes', 90)}
      </View>
      {input(attendees, setAttendees, 'Attendees, comma separated')}
      {create.error && <Text style={styles.error}>{errorMessage(create.error)}</Text>}
      <Button
        title="Create meeting"
        busy={create.isPending}
        disabled={!title.trim()}
        onPress={async () => {
          const startsAt = at(date, time);
          await create.mutateAsync({
            title: title.trim(),
            startsAt,
            endsAt: new Date(
              new Date(startsAt).getTime() + Number(minutes || 60) * 60_000,
            ).toISOString(),
            attendees: attendees
              .split(',')
              .map((a) => a.trim())
              .filter(Boolean),
          });
          onDone();
        }}
      />
    </View>
  );
}

/** Upcoming and past meetings: filter by status, search by title, scroll by cursor. */
export default function Meetings() {
  useScreenContext({ screen: 'meetings' });
  const [chip, setChip] = useState(chips[0]);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useEntityList('meetings', {
    ...chip.query,
    ...(q.trim() ? { q: q.trim() } : {}),
    sort: '-startsAt',
    limit: 25,
  });
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            <SearchBox value={q} onChange={setQ} placeholder="Search meetings" />
            <Button
              title={adding ? 'Cancel' : 'New meeting'}
              variant={adding ? 'ghost' : 'primary'}
              onPress={() => setAdding(!adding)}
            />
          </View>
          <FilterChips chips={chips} selected={chip.label} onSelect={setChip} />
          {adding && <NewMeeting onDone={() => setAdding(false)} />}
        </View>
      }
      renderItem={({ item }) => (
        <View style={[styles.card, { paddingVertical: 4, marginTop: 8 }]}>
          <MeetingRow meeting={item} />
        </View>
      )}
      ListEmptyComponent={!list.loading ? <Text style={styles.muted}>No meetings.</Text> : null}
      ListFooterComponent={
        list.hasMore ? <Button title="Load more" variant="ghost" onPress={list.loadMore} /> : null
      }
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
    />
  );
}
