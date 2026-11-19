import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type DeliveryChannel,
  type DeliveryOutcome,
  type DeliveryRequest,
  deliveryChannels,
} from '../../hooks.js';
import { InboxService } from './inbox.service.js';

/**
 * The `inapp` delivery channel: a notification that lists it lands in the person's in-app inbox
 * in its business. A Nest provider that registers itself, so it can use InboxService.
 */
@Injectable()
export class InboxChannel implements DeliveryChannel, OnModuleInit {
  readonly name = 'inapp';

  constructor(private readonly inbox: InboxService) {}

  onModuleInit() {
    if (deliveryChannels.get(this.name) !== this) deliveryChannels.register(this);
  }

  deliver(req: DeliveryRequest): Promise<DeliveryOutcome> {
    return this.inbox.deliver(req);
  }
}
