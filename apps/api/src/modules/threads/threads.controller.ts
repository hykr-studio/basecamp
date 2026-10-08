import { type Principal, type Thread, type ThreadMessage } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { ThreadsService } from './threads.service.js';

const view = (t: {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Thread => ({
  id: t.id,
  title: t.title,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

/** The person's conversations: the current one, a new one, and a thread's messages. */
@Controller('api/threads')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Get('current')
  async current(@CurrentPrincipal() p: Principal): Promise<Thread> {
    return view(await this.threads.current(p.actor.id));
  }

  /** A fresh conversation (the app's Clear). The old one stays in history. */
  @Post()
  async create(@CurrentPrincipal() p: Principal): Promise<Thread> {
    return view(await this.threads.create(p.actor.id));
  }

  @Get(':id/messages')
  async messages(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ThreadMessage[]> {
    await this.threads.owned(id, p.actor.id);
    return this.threads.messages(id);
  }
}
