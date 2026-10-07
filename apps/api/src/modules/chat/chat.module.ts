import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

/** The assistant's turns: the app's stream and JSON endpoints, and the service channels share. */
@Module({ controllers: [ChatController], providers: [ChatService], exports: [ChatService] })
export class ChatModule {}
