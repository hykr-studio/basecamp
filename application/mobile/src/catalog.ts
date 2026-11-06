/**
 * What this app serves: every entity and command (the domain's and the framework's) and every
 * view and screen the assistant may show here. Built from the domain package's aggregate entries,
 * so the app never reaches into one of its modules.
 */
import { domain } from '@application/domain/contracts';
import { uiDomain } from '@application/domain/views';
import { createCatalog } from '@hykr/contracts';
import { createUiRegistry } from '@hykr/ui-registry';

export const catalog = createCatalog(domain);
export const registry = createUiRegistry(uiDomain);

// Entity names and rows are typed in this app's screens: useEntityList('meetings') is MeetingView[].
declare module '@hykr/app' {
  interface Register {
    catalog: typeof catalog;
  }
}
