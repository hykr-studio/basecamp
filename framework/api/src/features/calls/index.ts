// Calls (decisions B17): a log of a business's phone calls on its records, click-to-call
// through a telephony provider an application adds (none ships), and the provider's updates
// written by a B10 connector handler as the system.
import { CallsCapabilities, DialCallSpec, LogCallSpec, type Principal } from '@hykr/contracts';
import { CurrentPrincipal, commandController, commandHandler, PrincipalGuard } from '@hykr/core';
import { commandTools, safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { z } from 'zod';
import { defineQueue } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { CallsService, DIAL_QUEUE, type DialJob } from './calls.service.js';
import { DialCall, LogCall, UpdateCall } from './commands.js';

/** A record's calls, the ones the person may see, one call, and whether calls can be placed. */
@Controller('api/calls')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() q: { entity?: string; id?: string }) {
    return { items: await this.calls.list(p, q) };
  }

  /** Whether this business can place calls (a telephony provider it may use). */
  @Get('provider')
  provider(@CurrentPrincipal() p: Principal) {
    return this.calls.provider(p);
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.calls.get(p, id);
  }
}

/** Each dial: the provider asked once. */
export const CallsDialQueue = defineQueue<DialJob, string>({
  name: DIAL_QUEUE,
  concurrency: 4,
  attempts: 1,
  process: (job, ctx) => ctx.get(CallsService).dial(job.data.callId),
});

/** A dial asked for (stored with its write): ask the provider. */
export const CallRequested = defineSubscriber({
  name: 'calls.dial',
  on: ['call.requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(CallsService).queueDial(event.resourceId, event.id);
  },
});

/** The assistant's call tools: log a call, dial (waits for approval), and a record's calls. */
export const callsTools: ToolContribution = {
  name: 'calls',
  tools: (kit) => ({
    ...commandTools([LogCallSpec, DialCallSpec], kit),
    'list-calls': createTool({
      id: 'list-calls',
      description: "A record's phone calls, newest first: who called whom, how it went, notes.",
      inputSchema: z.object({
        entity: z.string().min(1).describe("The record's kind (an entity name)"),
        id: z.string().min(1).describe("The record's id"),
      }),
      execute: async ({ entity, id }, ctx) =>
        safely('list-calls', ctx, kit, () => kit.clientFor(ctx).calls.list({ entity, id })),
    }),
  }),
};

export const callsFeature = defineFeature({
  name: 'calls',
  controllers: [
    CallsController,
    commandController(LogCall),
    commandController(DialCall),
    commandController(UpdateCall),
  ],
  providers: [
    CallsService,
    commandHandler(LogCall),
    commandHandler(DialCall),
    commandHandler(UpdateCall),
  ],
  exports: [CallsService],
  contributes: {
    capabilities: [CallsCapabilities.readAll],
    queues: [CallsDialQueue],
    subscribers: [CallRequested],
    toolContributions: [callsTools],
  },
});
