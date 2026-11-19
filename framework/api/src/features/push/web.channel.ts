import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type DeliveryChannel,
  type DeliveryOutcome,
  type DeliveryRequest,
  deliveryChannels,
} from '../../hooks.js';
import { WebPushService } from './web.service.js';

/**
 * The `webpush` delivery channel: a notification that lists it reaches the person's registered
 * browsers in its business (Web Push, VAPID), with the notification's push words. Registers
 * itself, as the push channel does.
 */
@Injectable()
export class WebPushChannel implements DeliveryChannel, OnModuleInit {
  readonly name = 'webpush';

  constructor(private readonly web: WebPushService) {}

  onModuleInit() {
    if (deliveryChannels.get(this.name) !== this) deliveryChannels.register(this);
  }

  deliver(req: DeliveryRequest): Promise<DeliveryOutcome> {
    return this.web.send(req);
  }
}
