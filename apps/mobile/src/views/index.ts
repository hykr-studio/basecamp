import { ApprovalCardView, KpiRowView, PageListView } from '@app/ui-registry';
import { bindView } from '@app/ui-registry/react';
import { ApprovalCardComponent, KpiRowComponent, PageListComponent } from './misc';

/**
 * This app's component for each of the framework's own views (approvals, numbers, saved
 * pages). The domain binds its views itself (src/domain). bindView checks each component's
 * props against the view's schema at compile time.
 */
export function bindPlatformViews() {
  bindView(ApprovalCardView, ApprovalCardComponent);
  bindView(KpiRowView, KpiRowComponent);
  bindView(PageListView, PageListComponent);
}
