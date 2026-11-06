// Live updates (B15): committed events, as ids, to the signed-in people who may read the record,
// over server-sent events. The worker publishes each stored event on its business's Redis
// channel; each API process checks it per stream. docs/decisions/A9B15.md.
import { ApprovalService } from '@hykr/core';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { LiveHub } from './hub.js';
import { LiveController } from './live.controller.js';
import { LivePublisher } from './publisher.js';
// Its registry first: installing `liveResources` needs the collector.
import './resources.js';
import type { LiveResource } from './resources.js';

/** Every committed event about a record goes to Redis, ids only. */
export const LiveRelay = defineSubscriber({
  name: 'live.relay',
  on: ['*'],
  when: (e) => e.resourceId !== null,
  handle: (event, ctx) => ctx.get(LivePublisher).publish(event),
});

/** An approval reaches the people who may decide it (its requester hears of it as its maker). */
export const ApprovalLive: LiveResource = {
  type: 'approval',
  visible: async (p, id, ctx) => {
    await ctx.get(ApprovalService).get(p, id);
    return true;
  },
};

export const liveFeature = defineFeature({
  name: 'live',
  controllers: [LiveController],
  providers: [LiveHub, LivePublisher],
  exports: [LiveHub],
  contributes: { subscribers: [LiveRelay], liveResources: [ApprovalLive] },
});
