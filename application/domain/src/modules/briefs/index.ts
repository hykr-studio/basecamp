/**
 * The briefs module, server side: briefs (what a customer needs, in their words), and the brief
 * form a business shares by link, whose answers are briefs.
 */
import { defineModule } from '@hykr/api';
import { briefsAgent } from './agent/index.js';
import { briefsSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { briefsNotifications } from './notifications/index.js';
import { BriefsModule } from './server/briefs.module.js';
import { BriefForm } from './server/form.js';
import { briefsViews } from './views/index.js';

export const briefs = defineModule({
  ...briefsSpec,
  server: BriefsModule,
  views: briefsViews.views,
  screens: briefsViews.screens,
  templates: briefsNotifications.templates,
  notifications: briefsNotifications.notifications,
  agent: briefsAgent,
  tables,
  contributes: { publicForms: [BriefForm] },
});
