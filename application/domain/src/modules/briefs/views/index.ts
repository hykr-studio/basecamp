/** The briefs module's views and screens. Isomorphic. */
import type { UiPart, ViewDef } from '@hykr/ui-registry';
import { BriefListView } from './brief.js';

export * from './brief.js';

export const briefsViews: UiPart = {
  name: 'briefs',
  views: [BriefListView] as unknown as readonly ViewDef[],
  screens: [],
};
