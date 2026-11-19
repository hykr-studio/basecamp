/** The briefs module's specs: isomorphic, read by the server and the apps. */
import { moduleSpec } from '@hykr/contracts';
import { BriefSpec } from './brief.js';

export * from './brief.js';

export const briefsSpec = moduleSpec({
  name: 'briefs',
  // The modules it builds on: it may import only their contracts/ and server/public.ts.
  dependsOn: [],
  entities: { briefs: BriefSpec },
  commands: [],
});
