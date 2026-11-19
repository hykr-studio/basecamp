import { ApprovalCardView, KpiRowView, MemoryListView, PageListView } from '@hykr/ui-registry';
import { bindView } from '@hykr/ui-registry/react';
import {
  ApprovalCardComponent,
  KpiRowComponent,
  MemoryListComponent,
  PageListComponent,
} from './misc';

/**
 * This app's component for each of the framework's own views (approvals, numbers, saved
 * pages, the business's memory). The domain binds its views itself (src/domain). bindView checks each component's
 * props against the view's schema at compile time.
 */
export function bindPlatformViews() {
  bindView(ApprovalCardView, ApprovalCardComponent);
  bindView(KpiRowView, KpiRowComponent);
  bindView(MemoryListView, MemoryListComponent);
  bindView(PageListView, PageListComponent);
}
