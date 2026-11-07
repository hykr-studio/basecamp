import { InboxQuery, MarkInboxRead, type Principal } from '@hykr/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@hykr/core';
import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { InboxService } from './inbox.service.js';

class InboxQueryDto extends createZodDto(InboxQuery) {}
class MarkReadDto extends createZodDto(MarkInboxRead) {}

/** A person's in-app inbox, in the business they work in. People only. */
@Controller('api/inbox')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: InboxQueryDto) {
    return this.inbox.list(p, q as unknown as z.output<typeof InboxQuery>);
  }

  @Post('read')
  @HttpCode(204)
  async read(@CurrentPrincipal() p: Principal, @Body() body: MarkReadDto): Promise<void> {
    await this.inbox.markRead(p, body as MarkInboxRead);
  }
}
