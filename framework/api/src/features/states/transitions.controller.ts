import type { Principal, WriteResult } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  RequireScope,
  runWrite,
  statesEntity,
  transitionOp,
} from '@hykr/core';
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';

/**
 * POST /api/transitions/:plural/:id/:transition: move a record along its state machine. The
 * body carries the transition's own fields (a reason). Answers like any write: done with the
 * record, or needs_approval with the approval it parked. A scoped credential (an MCP client's
 * token) needs the write scope of the module the records belong to.
 */
@Controller('api/transitions')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class TransitionsController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  @Post(':plural/:id/:transition')
  @HttpCode(200)
  @RequireScope({
    access: 'write',
    module: (req) => statesEntity(String(req.params.plural ?? ''))?.spec.module,
  })
  async run(
    @CurrentPrincipal() p: Principal,
    @Param('plural') plural: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('transition') name: string,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult> {
    const def = statesEntity(plural);
    if (!def) throw new NotFoundException({ error: 'not_found', message: `No such records` });
    const op = transitionOp(def, { id, transition: name });
    const input = op.input.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const { result, events } = await runWrite(
      this.options.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input.data,
    );
    // After commit: whoever listens in this process sees only committed moves.
    for (const event of events) this.events.publish(event);
    return result;
  }
}
