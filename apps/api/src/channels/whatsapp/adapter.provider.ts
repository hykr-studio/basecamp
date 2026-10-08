import { type ChannelAdapter, createWhatsAppAdapter } from '@app/channels';
import { Logger } from '@nestjs/common';
import { config } from '../../config.js';

/** The WhatsApp adapter, as configured: whaloc in development and CI, Meta elsewhere. */
export const WHATSAPP = Symbol('WHATSAPP');

const log = new Logger('WhatsApp');

export const whatsappProvider = {
  provide: WHATSAPP,
  useFactory: (): ChannelAdapter =>
    createWhatsAppAdapter({
      graphUrl: config.whatsapp.graphUrl,
      apiVersion: config.whatsapp.apiVersion,
      accessToken: config.whatsapp.accessToken,
      appSecret: config.whatsapp.appSecret,
      wabaId: config.whatsapp.wabaId,
      log: (m) => log.warn(m),
    }),
};

/** A Redis client for short locks (one turn per sender at a time). */
export const REDIS = Symbol('REDIS');
