import type { Principal } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { type Database, schema } from '@app/db';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, eq } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { ContactsService } from '../contacts.service.js';
import { LinkingService } from './linking.service.js';

const { contacts } = schema;

/** wa_id: digits only, no plus, no spaces. */
export const toWaId = (phone: string) => phone.replace(/\D/g, '');

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return 'Asia/Kolkata';
  }
};

const Phone = z.string().regex(/^\+?[\d\s()-]{7,20}$/, 'A phone number, with the country code');

class CodeDto extends createZodDto(
  z.object({
    phone: Phone,
    timeZone: z.string().min(1).max(64).default('Asia/Kolkata'),
    lang: z.enum(['en', 'hi', 'te']).default('en'),
  }),
) {}

class VerifyDto extends createZodDto(
  z.object({ phone: Phone, code: z.string().regex(/^\d{6}$/, 'The 6-digit code') }),
) {}

class NumberDto extends createZodDto(
  z.object({
    phoneNumberId: z.string().min(1).max(64).optional(),
    displayName: z.string().max(80).optional(),
  }),
) {}

/**
 * The person's own WhatsApp number, linked to their account in their business by a one-time
 * code sent to it: messages from it then act as them.
 */
@Controller('api/channels/whatsapp')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class WhatsAppLinkController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly linking: LinkingService,
  ) {}

  @Get()
  async get(@CurrentPrincipal() p: Principal) {
    const [row] = await this.db
      .select({ address: contacts.address, timeZone: contacts.timeZone })
      .from(contacts)
      .where(and(eq(contacts.tenantId, p.tenantId ?? ''), eq(contacts.userId, p.actor.id)));
    return row ?? null;
  }

  /** Send a one-time code to the number (login_code_v1): proof the person holds it. */
  @Post('code')
  sendCode(@CurrentPrincipal() p: Principal, @Body() body: CodeDto) {
    return this.linking.sendCode(p, toWaId(body.phone), validZone(body.timeZone), body.lang);
  }

  /** The code they received: the number is linked to their account. */
  @Post('verify')
  verify(@CurrentPrincipal() p: Principal, @Body() body: VerifyDto) {
    return this.linking.verify(p, toWaId(body.phone), body.code);
  }

  @Delete()
  @HttpCode(204)
  async unlink(@CurrentPrincipal() p: Principal) {
    await this.db
      .update(contacts)
      .set({ userId: null, linkedAt: null })
      .where(and(eq(contacts.tenantId, p.tenantId ?? ''), eq(contacts.userId, p.actor.id)));
  }

  /**
   * Make a WhatsApp Business number this business's (the configured one by default): messages
   * to it are this business's conversations. Owners and admins only.
   */
  @Post('number')
  async claim(@CurrentPrincipal() p: Principal, @Body() body: NumberDto) {
    if (!(p.roles ?? []).some((r) => r === 'owner' || r === 'admin'))
      throw new ForbiddenException('Only an owner or admin can set the business number');
    // The configured number is a development convenience; production names the number.
    const phoneNumberId =
      body.phoneNumberId ??
      (process.env.NODE_ENV === 'production' ? undefined : config.whatsapp.phoneNumberId);
    if (!phoneNumberId) throw new BadRequestException('Name the phoneNumberId to claim');
    if (!(await this.contacts.claimNumber(phoneNumberId, p.tenantId ?? '', body.displayName)))
      throw new ConflictException('That number belongs to another business');
    return { phoneNumberId };
  }
}
