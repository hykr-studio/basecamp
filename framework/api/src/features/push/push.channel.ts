import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type DeliveryChannel,
  type DeliveryOutcome,
  type DeliveryRequest,
  deliveryChannels,
} from '../../hooks.js';
import { PushPlaces } from './place.js';

/**
 * The `push` delivery channel: a notification that lists it reaches the person in one place,
 * the phone or browser they used most recently (the next one only when that one cannot take
 * it). A notification that also lists `webpush` orders the two itself: there, `push` means
 * phones only. A phone's send that fails later (its receipt) moves on to the next channel in the
 * list, not to another device. A Nest provider that registers itself.
 */
@Injectable()
export class PushChannel implements DeliveryChannel, OnModuleInit {
  readonly name = 'push';

  constructor(private readonly places: PushPlaces) {}

  onModuleInit() {
    if (deliveryChannels.get(this.name) !== this) deliveryChannels.register(this);
  }

  deliver(req: DeliveryRequest): Promise<DeliveryOutcome> {
    const browsers = !req.notification.channels.includes('webpush');
    return this.places.deliver(req, { phones: true, browsers });
  }
}
