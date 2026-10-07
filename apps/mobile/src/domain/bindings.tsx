import {
  CalendarDayView,
  CalendarWeekView,
  MeetingCardView,
  MeetingDetailScreen,
  MeetingListView,
  NoteCardView,
  NoteDetailScreen,
  NoteListView,
  TodoItemView,
  TodoListView,
} from '@app/ui-registry';
import { bindScreen, bindView } from '@app/ui-registry/react';
import { MeetingDetail } from './screens/MeetingDetail';
import { NoteDetail } from './screens/NoteDetail';
import {
  CalendarDayComponent,
  CalendarWeekComponent,
  MeetingCardComponent,
  MeetingListComponent,
} from './views/meeting';
import { NoteCardComponent, NoteListComponent } from './views/note';
import { TodoItemComponent, TodoListComponent } from './views/todo';

/**
 * This app's component for each of the domain's views and screens. bindView checks each
 * component's props against the view's schema at compile time.
 */
export function bindDomain() {
  bindView(TodoListView, TodoListComponent);
  bindView(TodoItemView, TodoItemComponent);
  bindView(NoteListView, NoteListComponent);
  bindView(NoteCardView, NoteCardComponent);
  bindView(MeetingListView, MeetingListComponent);
  bindView(MeetingCardView, MeetingCardComponent);
  bindView(CalendarDayView, CalendarDayComponent);
  bindView(CalendarWeekView, CalendarWeekComponent);
  // The canvas shows the same screens as the app's routes.
  bindScreen(MeetingDetailScreen, ({ id }) => <MeetingDetail id={id} embedded />);
  bindScreen(NoteDetailScreen, ({ id }) => <NoteDetail id={id} />);
}
