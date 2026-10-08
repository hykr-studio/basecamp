import type { MeetingView } from '@app/contracts';
import type {
  CalendarDayView,
  CalendarWeekView,
  MeetingCardView,
  MeetingListView,
} from '@app/ui-registry';
import type { ViewProps } from '@app/ui-registry/react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { clock, dayLabel, when } from '../../framework/dates';
import { OpenRow, Rows, ViewCard } from '../../views/parts';
import { MeetingStatus } from '../meetings';

const ymdOf = (iso: string) => new Date(iso).toLocaleDateString('sv');

function MeetingLine({ m, onOpen }: { m: MeetingView; onOpen: () => void }) {
  return (
    <OpenRow label={`Open ${m.title}, ${when(m.startsAt)}`} onPress={onOpen}>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="shrink font-semibold">{m.title}</Text>
        <MeetingStatus meeting={m} />
      </View>
      <Text variant="muted">
        {when(m.startsAt)}–{clock(m.endsAt)}
        {m.attendees.length ? ` · ${m.attendees.join(', ')}` : ''}
      </Text>
    </OpenRow>
  );
}

export function MeetingListComponent({
  title,
  items,
  act,
  words,
}: ViewProps<typeof MeetingListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(m) => <MeetingLine m={m} onOpen={() => act('open', m)} />}
      </Rows>
    </ViewCard>
  );
}

export function MeetingCardComponent({ item, act }: ViewProps<typeof MeetingCardView>) {
  return (
    <ViewCard>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text variant="heading" className="shrink">
          {item.title}
        </Text>
        <MeetingStatus meeting={item} />
      </View>
      <Text variant="muted">
        {when(item.startsAt)}–{clock(item.endsAt)}
        {item.attendees.length ? ` · ${item.attendees.join(', ')}` : ''}
      </Text>
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        onPress={() => act('open', item)}
      >
        <Text>Open the meeting</Text>
      </Button>
    </ViewCard>
  );
}

/**
 * Meetings by time, grouped by day: one day, or (as the phone form of calendar.week) each
 * day of a range under its own heading.
 */
export function CalendarDayComponent({
  title,
  date,
  items,
  act,
}: ViewProps<typeof CalendarDayView>) {
  const days = [...new Set(items.map((m) => ymdOf(m.startsAt)))];
  const grouped = days.length > 1 || !date;
  return (
    <ViewCard title={title ?? (date ? dayLabel(date) : 'Meetings')} count={items.length}>
      {items.length === 0 && <Text variant="muted">No meetings.</Text>}
      {days.map((day) => (
        <View key={day} className="gap-0.5">
          {grouped && (
            <Text variant="label" className="text-muted">
              {dayLabel(day)}
            </Text>
          )}
          <Rows items={items.filter((m) => ymdOf(m.startsAt) === day)} empty="">
            {(m) => (
              <OpenRow label={`Open ${m.title}`} onPress={() => act('open', m)}>
                <View className="flex-row items-baseline gap-3">
                  <Text variant="muted" className="w-[72px] tabular-nums">
                    {clock(m.startsAt)}
                  </Text>
                  <Text className="shrink font-semibold">{m.title}</Text>
                </View>
              </OpenRow>
            )}
          </Rows>
        </View>
      ))}
    </ViewCard>
  );
}

/** Seven columns from `start`; the canvas swaps in calendar.day on a narrow screen. */
export function CalendarWeekComponent({
  title,
  start,
  items,
  act,
}: ViewProps<typeof CalendarWeekView>) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${start}T00:00:00`);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString('sv');
  });
  const today = new Date().toLocaleDateString('sv');
  return (
    <ViewCard title={title ?? `Week of ${dayLabel(start)}`} count={items.length}>
      <View className="flex-row gap-1">
        {days.map((day) => {
          const meetings = items.filter((m) => ymdOf(m.startsAt) === day);
          return (
            <View
              key={day}
              className={`min-h-24 flex-1 gap-1 rounded-control p-1.5 ${day === today ? 'bg-primary-tint' : 'bg-bg'}`}
            >
              <Text variant="label" className={day === today ? 'text-primary' : 'text-muted'}>
                {dayLabel(day)}
              </Text>
              {meetings.map((m) => (
                <Button
                  key={m.id}
                  variant="secondary"
                  size="sm"
                  className="min-h-9 items-start justify-start px-1.5 py-1"
                  accessibilityLabel={`Open ${m.title}, ${when(m.startsAt)}`}
                  onPress={() => act('open', m)}
                >
                  <Text variant="muted" className="text-text" numberOfLines={2}>
                    {clock(m.startsAt)} {m.title}
                  </Text>
                </Button>
              ))}
            </View>
          );
        })}
      </View>
    </ViewCard>
  );
}
