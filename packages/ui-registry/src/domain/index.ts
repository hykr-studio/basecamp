/**
 * THE DOMAIN's views and screens: what the assistant may show for meetings, notes and
 * to-dos. Replace this folder with another domain's; the framework reads only `uiDomain`.
 */
import type { ScreenDef, ViewDef } from '../define-view.js';
import { CalendarDayView, CalendarWeekView, MeetingCardView, MeetingListView } from './meeting.js';
import { NoteCardView, NoteListView } from './note.js';
import { MeetingDetailScreen, NoteDetailScreen } from './screens.js';
import { TodoItemView, TodoListView } from './todo.js';

export * from './meeting.js';
export * from './note.js';
export * from './screens.js';
export * from './todo.js';

export const uiDomain = {
  views: [
    TodoListView,
    TodoItemView,
    NoteListView,
    NoteCardView,
    MeetingListView,
    MeetingCardView,
    CalendarDayView,
    CalendarWeekView,
  ] as unknown as readonly ViewDef[],
  screens: [MeetingDetailScreen, NoteDetailScreen] as unknown as readonly ScreenDef[],
};
