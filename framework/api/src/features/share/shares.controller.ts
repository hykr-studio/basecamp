import {
  CreateShareInput,
  DraftReissueInput,
  DraftShareInput,
  type Principal,
  type ShareCreated,
  type ShareDrafted,
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
import { verifiedOriginOf } from '../settings/domains.js';
import { createOp, reissueOp, renewOp, revokeOp } from './ops.js';
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
  kinds(@CurrentPrincipal() p: Principal): Promise<ShareKinds> {
    return this.shares.kinds(p);
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
   * A new link (share.create), sent to its recipient when `send` asks. No idempotency key: a
   * stored answer would keep the token in the database, which keeps only its hash.
   */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult<ShareCreated>> {
    const result = await this.write(p, meta, createOp(), body, { idempotent: false });
    return this.made(p, result);
  }

  /** A link's new end date (or none), its token and address unchanged (share.renew). */
  @Post(':id/renew')
  @HttpCode(200)
  renew(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.write(p, meta, renewOp(id), body, { idempotent: true });
  }

  /**
   * The link revoked and a new one like it made (share.reissue), its new token answered once and
   * sent to its recipient when `send` asks. Not idempotent, like making one.
   */
  @Post(':id/reissue')
  @HttpCode(201)
  async reissue(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult<ShareCreated>> {
    const result = await this.write(p, meta, reissueOp(id), body, { idempotent: false });
    return this.made(p, result);
  }

  /** A made link's answer: its path and its URL, on the business's own domain when it has one. */
  private async made(p: Principal, result: WriteResult): Promise<WriteResult<ShareCreated>> {
    if (result.status !== 'done') return result as WriteResult<ShareCreated>;
    const made = result.value as ShareLinkInfo & { token: string };
    const path = sharePath(made.token);
    const origin = (await verifiedOriginOf(this.options.db, p.tenantId ?? '')) ?? config.appUrl;
    return { status: 'done', value: { ...made, path, url: `${origin}${path}` } };
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

/**
 * The assistant's drafts (decisions B21): a link and its send to a named recipient
 * (`create-share-link`), or a reissue that sends a new one (`send-share-link`). The assistant's
 * draft waits for its person's approval; a person may use these too. The answer never holds the
 * token or the address, so a stored answer (idempotency) keeps neither.
 */
@Controller('api/shares/drafts')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class ShareDraftsController {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  private async run<I>(
    p: Principal,
    meta: RequestMetaValue,
    // biome-ignore lint/suspicious/noExplicitAny: each operation's own loaded and value types
    op: WriteOp<I, any, any>,
    input: I,
  ): Promise<WriteResult<ShareDrafted>> {
    const { result } = await runWrite(
      this.options.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input,
    );
    return result as WriteResult<ShareDrafted>;
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    const draft = DraftShareInput.safeParse(body ?? {});
    if (!draft.success)
      throw new BadRequestException({ error: 'invalid', issues: draft.error.issues });
    const { channel, ...rest } = draft.data;
    const input = CreateShareInput.parse({ ...rest, send: channel ? { channel } : {} });
    return this.run(p, meta, createOp({ via: 'draft' }), input);
  }

  @Post('reissue/:id')
  @HttpCode(201)
  reissue(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    const draft = DraftReissueInput.safeParse(body ?? {});
    if (!draft.success)
      throw new BadRequestException({ error: 'invalid', issues: draft.error.issues });
    const channel = draft.data.channel;
    return this.run(p, meta, reissueOp(id, { via: 'draft' }), {
      send: channel ? { channel } : {},
    });
  }
}
