import type { Principal } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { WhatsappService } from './whatsapp.service.js';

/**
 * Meta's webhook (whaloc in development). Not a session route: each delivery proves itself
 * with the app secret's signature, and acts only for the person its number is linked to.
 */
@Controller('webhooks/whatsapp')
@AllowAnonymous()
export class WhatsappWebhookController {
  constructor(private readonly whatsapp: WhatsappService) {}

  /** The one-time subscription check: echo the challenge if the verify token matches. */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (
      mode !== 'subscribe' ||
      !config.whatsapp.verifyToken ||
      token !== config.whatsapp.verifyToken
    )
      throw new ForbiddenException('verify token mismatch');
    return challenge;
  }

  /** Acknowledged at once (Meta retries slow webhooks); the replies are sent after. */
  @Post()
  @HttpCode(200)
  receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    if (!this.whatsapp.verifySignature(req.rawBody, signature))
      throw new ForbiddenException('bad signature');
    void this.whatsapp.handle(req.body);
    return { ok: true };
  }
}

class LinkDto extends createZodDto(
  z.object({
    phone: z.string().regex(/^\+?[\d\s()-]{7,20}$/, 'A phone number, with the country code'),
    timeZone: z.string().min(1).max(64).default('UTC'),
  }),
) {}

/** The person links their own number; the assistant cannot. */
@Controller('api/channels/whatsapp')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ChannelsController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get()
  get(@CurrentPrincipal() p: Principal) {
    return this.whatsapp.linkOf(p.actor.id);
  }

  @Post()
  async link(@CurrentPrincipal() p: Principal, @Body() body: LinkDto) {
    let timeZone = 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.timeZone });
      timeZone = body.timeZone;
    } catch {}
    const link = await this.whatsapp.link(p.actor.id, body.phone, timeZone);
    if (!link) throw new ConflictException('That number is linked to another account');
    return link;
  }

  @Delete()
  @HttpCode(204)
  async unlink(@CurrentPrincipal() p: Principal) {
    await this.whatsapp.unlink(p.actor.id);
  }
}
