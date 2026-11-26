/**
 * Views and screens the framework owns in every domain: approvals, numbers, saved pages, the
 * business's memory.
 */
import type { ScreenDef, ViewDef } from '../define-view.js';
import { MemoryListView } from './memory.js';
import { PageListView } from './page.js';
import { PageScreen } from './screens.js';
import { ApprovalCardView, KpiRowView } from './views.js';

export * from './kpi.js';
export * from './memory.js';
export * from './page.js';
export * from './screens.js';
export * from './views.js';

export const platformViews = [
  ApprovalCardView,
  KpiRowView,
  MemoryListView,
  PageListView,
] as unknown as readonly ViewDef[];
export const platformScreens = [PageScreen] as unknown as readonly ScreenDef[];
