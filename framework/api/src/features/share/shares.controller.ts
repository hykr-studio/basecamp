import {
  type Principal,
  type ShareCreated,
  type ShareKinds,
  type ShareLinkInfo,
  sharePath,
  type WriteResult,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
  type WriteOp,
} from '@hykr/core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { config } from '../../config.js';
import { createOp, revokeOp } from './ops.js';
import { ShareService } from './share.service.js';

/**
 * The team's share links (decisions B9), people only: what may be shared, a target's links,
 * making one (its token in this answer only) and revoking one. Every write through `runWrite`.
 */
@Controller('api/shares')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class SharesController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    private readonly shares: ShareService,
  ) {}

  private async write<I>(
    p: Principal,
    meta: RequestMetaValue,
    // biome-ignore lint/suspicious/noExplicitAny: each operation's own loaded and value types
    op: WriteOp<I, any, any>,
    body: unknown,
    opts: { idempotent: boolean },
  ): Promise<WriteResult> {
    const input = op.input.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const { result } = await runWrite(
      this.options.db,
      {
        principal: p,
        requestId: meta.requestId,
        ...(opts.idempotent ? { idempotencyKey: meta.idempotencyKey } : {}),
      },
      op,
      input.data,
    );
    return result;
  }

  @Get('kinds')
  kinds(): ShareKinds {
    return this.shares.kinds();
  }

  /** A record's (`?entity&id`), a page's (`?page`) or a form's (`?form`) links, newest first. */
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query('entity') entity?: string,
    @Query('id') id?: string,
    @Query('page') page?: string,
    @Query('form') form?: string,
  ): Promise<{ items: ShareLinkInfo[] }> {
    if (!(entity && id) && !page && !form)
      throw new BadRequestException({
        error: 'bad_query',
        message: 'Name what is shared: ?entity=<entity>&id=<id>, ?page=<id> or ?form=<name>',
      });
    return { items: await this.shares.list(p, { entity, id, page, form }) };
  }

  /**
   * A new link (share.create). No idempotency key: a stored answer would keep the token in the
   * database, which keeps only its hash.
   */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult<ShareCreated>> {
    const result = await this.write(p, meta, createOp(), body, { idempotent: false });
    if (result.status !== 'done') return result as WriteResult<ShareCreated>;
    const made = result.value as ShareLinkInfo & { token: string };
    const path = sharePath(made.token);
    return { status: 'done', value: { ...made, path, url: `${config.appUrl}${path}` } };
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.write(p, meta, revokeOp(id), {}, { idempotent: true });
  }
}
