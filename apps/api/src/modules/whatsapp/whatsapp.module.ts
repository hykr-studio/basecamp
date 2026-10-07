import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module.js';
import { ChannelsController, WhatsappWebhookController } from './whatsapp.controller.js';
import { WhatsappService } from './whatsapp.service.js';

/** The assistant over WhatsApp: the webhook, and the person's own number link. */
@Module({
  imports: [ChatModule],
  controllers: [WhatsappWebhookController, ChannelsController],
  providers: [WhatsappService],
})
export class WhatsappModule {}
