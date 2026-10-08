import { commandController, commandHandler } from '@app/core';
import {
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { ChatModule } from '../modules/chat/chat.module.js';
import { ThreadsModule } from '../modules/threads/threads.module.js';
import { ContactsService } from './contacts.service.js';
import { BackOfficeController, HandoffRequestController } from './handoff/backoffice.controller.js';
import { HandoffService } from './handoff/handoff.service.js';
import { ErasureService } from './maintenance/erasure.service.js';
import { MaintenanceProcessor } from './maintenance/maintenance.processor.js';
import { DeliveryFallback, DispatchProcessor } from './notify/dispatch.processor.js';
import { MailerService } from './notify/mailer.service.js';
import { NotifyService } from './notify/notify.service.js';
import { OutboxRelay } from './notify/outbox.relay.js';
import { SendTemplate } from './notify/send-template.command.js';
import { OutboundService } from './outbound.service.js';
import { queueImports } from './queues.js';
import { TemplatesProcessor } from './templates/templates.processor.js';
import { TenantsService } from './tenants.service.js';
import { REDIS, whatsappProvider } from './whatsapp/adapter.provider.js';
import { InboundProcessor } from './whatsapp/inbound.processor.js';
import { WhatsAppLinkController } from './whatsapp/link.controller.js';
import { LinkingService } from './whatsapp/linking.service.js';
import { SendProcessor } from './whatsapp/send.processor.js';
import { SttService } from './whatsapp/stt.service.js';
import { WhatsAppWebhookController } from './whatsapp/webhook.controller.js';

/**
 * The channel (WhatsApp now): webhooks, the inbound pipeline, sending, notifications. The API
 * process registers it without processors (it only adds jobs); the worker, and tests running
 * inline, register the processors too.
 */
@Module({})
export class ChannelsModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** The lock client closes with the app (the queues close their own connections). */
  async onApplicationShutdown() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  static forRoot(opts: { processors: boolean }): DynamicModule {
    const processors: Provider[] = [
      InboundProcessor,
      SendProcessor,
      MaintenanceProcessor,
      TemplatesProcessor,
      DispatchProcessor,
      OutboxRelay,
    ];
    return {
      module: ChannelsModule,
      imports: [...queueImports, ChatModule, ThreadsModule],
      controllers: [
        WhatsAppWebhookController,
        WhatsAppLinkController,
        commandController(SendTemplate),
        BackOfficeController,
        HandoffRequestController,
      ],
      providers: [
        whatsappProvider,
        {
          provide: REDIS,
          useFactory: () => new Redis(config.redisUrl, { maxRetriesPerRequest: null }),
        },
        ContactsService,
        OutboundService,
        TenantsService,
        HandoffService,
        ErasureService,
        LinkingService,
        SttService,
        NotifyService,
        MailerService,
        DeliveryFallback,
        commandHandler(SendTemplate),
        ...(opts.processors ? processors : []),
      ],
      exports: [
        ...queueImports,
        ContactsService,
        OutboundService,
        TenantsService,
        HandoffService,
        NotifyService,
        whatsappProvider,
      ],
    };
  }
}
