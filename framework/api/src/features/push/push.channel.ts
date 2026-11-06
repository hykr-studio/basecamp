import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type DeliveryChannel,
  type DeliveryOutcome,
  type DeliveryRequest,
  deliveryChannels,
} from '../../hooks.js';
import { PushService } from './push.service.js';

/**
 * The `push` delivery channel: a notification that lists it reaches the person's registered
 * devices in its business. A Nest provider that registers itself, so it can use PushService.
 */
@Injectable()
export class PushChannel implements DeliveryChannel, OnModuleInit {
  readonly name = 'push';

  constructor(private readonly push: PushService) {}

  onModuleInit() {
    if (deliveryChannels.get(this.name) !== this) deliveryChannels.register(this);
  }

  deliver(req: DeliveryRequest): Promise<DeliveryOutcome> {
    return this.push.send(req);
  }
}
