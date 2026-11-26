/**
 * The briefs module, app side: its destination and its views' components. Other code
 * imports this file only, never a file under it.
 */

import { BriefListView } from '@application/domain/modules/briefs/views';
import { defineAppModule } from '@hykr/app';
import { bindView } from '@hykr/ui-registry/react';
import { BriefListComponent } from './views';

export const briefs = defineAppModule({
  name: 'briefs',
  nav: [
    {
      href: '/briefs',
      label: 'Briefs',
      icon: 'list',
      match: (path: string) => path.startsWith('/briefs'),
    },
  ],
  suggestions: [],
  bind: () => {
    bindView(BriefListView, BriefListComponent);
  },
});
