import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type DeliveryChannel,
  type DeliveryOutcome,
  type DeliveryRequest,
  deliveryChannels,
} from '../../hooks.js';
import { PushService } from './push.service.js';
import { WebPushService } from './web.service.js';

/**
 * The `push` delivery channel: a notification that lists it reaches the person's registered
 * phones in its business, and when no phone takes it (none registered, or every one refused),
 * their browsers. A notification that also lists `webpush` orders the two itself: there, `push`
 * means phones only. A phone's send that fails later (its receipt) moves on to the next channel
 * in the list, not to the browsers. A Nest provider that registers itself, so it can use the
 * services.
 */
@Injectable()
export class PushChannel implements DeliveryChannel, OnModuleInit {
  readonly name = 'push';

  constructor(
    private readonly push: PushService,
    private readonly web: WebPushService,
  ) {}

  onModuleInit() {
    if (deliveryChannels.get(this.name) !== this) deliveryChannels.register(this);
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryOutcome> {
    const phones = await this.push.send(req);
    if (phones.status === 'sent' || req.notification.channels.includes('webpush')) return phones;
    const browsers = await this.web.send(req);
    if (browsers.status === 'sent') return browsers;
    if (browsers.status === 'unavailable') return phones;
    if (phones.status === 'unavailable') return browsers;
    // Both failed: tried again if either may work later.
    return {
      status: 'failed',
      reason: `${phones.reason}; ${browsers.reason}`,
      final: phones.final && browsers.final,
    };
  }
}
