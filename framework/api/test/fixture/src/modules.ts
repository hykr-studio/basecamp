// The fixture as an application of two modules: what defineServer merges and checks at boot.
import { defineModule } from '@hykr/api';
import type { ViewDef } from '@hykr/ui-registry';
import { tasksAgent } from './agent.js';
import { tasksSpec, visitsSpec } from './contracts.js';
import { TaskDue, VisitReminder, VisitReminderNotification } from './notifications.js';
import { tasks as tasksTable, visits as visitsTable } from './schema.js';
import { TasksModule, VisitsModule } from './server.js';
import { TaskListView } from './views.js';

/** Tasks: plain CRUD, a list view, a due-date template, and the scripted model's verbs. */
export const tasks = defineModule({
  ...tasksSpec,
  server: TasksModule,
  views: [TaskListView] as unknown as readonly ViewDef[],
  templates: [TaskDue],
  agent: tasksAgent,
  tables: { tasksTable },
});

/** Visits: a time, a command that moves it, and a reminder before it. */
export const visits = defineModule({
  ...visitsSpec,
  server: VisitsModule,
  templates: [VisitReminder],
  notifications: [VisitReminderNotification],
  tables: { visitsTable },
});
