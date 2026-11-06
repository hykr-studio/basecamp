/** The to-dos module, server side: short tasks with a due date, optionally from a meeting. */
import { defineModule } from '@hykr/api';
import { todosAgent } from './agent/index.js';
import { ClearDoneFlag, todosSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { todosNotifications } from './notifications/index.js';
import { TodosModule } from './server/todos.module.js';
import { todosViews } from './views/index.js';

export const todos = defineModule({
  ...todosSpec,
  server: TodosModule,
  views: todosViews.views,
  screens: todosViews.screens,
  templates: todosNotifications.templates,
  notifications: todosNotifications.notifications,
  agent: todosAgent,
  tables,
  contributes: { featureFlags: [ClearDoneFlag] },
});
