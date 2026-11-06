// Live updates (B15) as an application extends them: a check for a record type that is not an
// entity. Only the live e2e test boots `liveApp`.
import { defineServer, type LiveResource } from '@hykr/api';
import { fixture } from '../../index.js';

/** Records of this type are readable when their id starts with "yes". */
export const ThingLive: LiveResource = {
  type: 'fixture-thing',
  visible: async (_p, id) => id.startsWith('yes'),
};

/** The fixture, with the check above. */
export const liveApp = defineServer({
  ...fixture.definition,
  contributes: { liveResources: [ThingLive] },
});
