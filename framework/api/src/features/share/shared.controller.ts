import {
  type AcceptanceStatus,
  AcceptInput,
  customForCreate,
  type DocumentInfo,
  Lang,
  type Principal,
  publicForms,
  type Shared,
  ShareSubmitInput,
  ShareVerifyInput,
  type WriteResult,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  PrincipalResolver,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
  ShareGateOpen,
  ShareGuard,
  type ShareRequest,
  shareOf,
  type WriteOp,
} from '@hykr/core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { OtpService } from '../../channels/otp/otp.service.js';
import { AcceptanceService } from '../acceptance/acceptance.service.js';
import type { Binding } from '../acceptance/checks.js';
import { ACCEPTANCE_PURPOSE } from '../acceptance/checks.js';
import { acceptOp, type ClientInfo, challengeOp, guessCode } from '../acceptance/ops.js';
import { codeOp, ofLink, submitOp, verifyOp } from './ops.js';
import { ShareService } from './share.service.js';

type Values = Record<string, unknown>;

const header = (req: ShareRequest, name: string, max: number) => {
  const v = req.headers[name];
  const text = Array.isArray(v) ? v.join(', ') : v;
  return text ? text.slice(0, max) : null;
};

/** The request's address, x-forwarded-for as sent, and user agent (decisions B8, 21). */
const clientOf = (req: ShareRequest): ClientInfo => ({
  ip: req.ip ?? null,
  forwardedFor: header(req, 'x-forwarded-for', 300),
  userAgent: header(req, 'user-agent', 500),
});

const principalOf = (req: ShareRequest): Principal => {
  if (!req.principal) throw new Error('A share route without ShareGuard');
  return req.principal;
};

/**
 * What a guest does through a share link (decisions B9): see it, ask for and enter its code,
 * open its PDFs, accept one, and answer its form. Anonymous for Better Auth; `ShareGuard` turns
 * the token into the guest's principal, and everything is read and written as that principal.
 */
@Controller('api/share/:token')
@AllowAnonymous()
@UseGuards(ShareGuard)
export class SharedController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
    private readonly resolver: PrincipalResolver,
    private readonly shares: ShareService,
  ) {}

  private get otp(): OtpService {
    return this.ref.get(OtpService, { strict: false });
  }

  private get acceptances(): AcceptanceService {
    return this.ref.get(AcceptanceService, { strict: false });
  }

  private async write<I>(
    p: Principal,
    meta: RequestMetaValue,
    // biome-ignore lint/suspicious/noExplicitAny: each operation's own loaded and value types
    op: WriteOp<I, any, any>,
    body: unknown,
    opts: { idempotent: boolean } = { idempotent: true },
  ): Promise<WriteResult> {
    const input = op.input.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const { result, events } = await runWrite(
      this.options.db,
      {
        principal: p,
        requestId: meta.requestId,
        ...(opts.idempotent ? { idempotencyKey: meta.idempotencyKey } : {}),
      },
      op,
      input.data,
    );
    for (const event of events) this.events.publish(event);
    return result;
  }

  /** What the link shows: its gate until its code, then the record, page or form. */
  @Get()
  @ShareGateOpen()
  get(@Req() req: ShareRequest): Promise<Shared> {
    const { link, verified } = shareOf(req);
    return this.shares.shared(link, principalOf(req), verified);
  }

  /** A gated link's code, to its recipient (share.code). */
  @Post('code')
  @ShareGateOpen()
  @HttpCode(200)
  code(@Req() req: ShareRequest, @Body() body: unknown, @RequestMeta() meta: RequestMetaValue) {
    return this.write(principalOf(req), meta, codeOp(this.otp, shareOf(req).link), body);
  }

  /**
   * The code received: a session for this device (share.verify). The guess is spent first, on
   * the pool, with no transaction open (decisions B8, 11). No idempotency key: a stored answer
   * would keep the session's token.
   */
  @Post('verify')
  @ShareGateOpen()
  @HttpCode(200)
  async verify(
    @Req() req: ShareRequest,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult> {
    const { link } = shareOf(req);
    const input = ShareVerifyInput.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const ch = await this.otp.get(input.data.challengeId);
    if (!ofLink(ch, link))
      throw new NotFoundException({ error: 'not_found', message: 'No such code' });
    const outcome = await this.otp.guess(ch, input.data.code);
    if (outcome === 'wrong')
      throw new BadRequestException({ error: 'wrong_code', message: "That code isn't right" });
    if (outcome === 'none')
      throw new BadRequestException({
        error: 'no_code',
        message: 'This code is used or has expired: ask for a new one',
      });
    return this.write(principalOf(req), meta, verifyOp(this.otp, link), input.data, {
      idempotent: false,
    });
  }

  /** One of the record's declared PDFs, with a short-lived download URL. */
  @Get('documents/:documentId')
  document(
    @Req() req: ShareRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<DocumentInfo> {
    return this.shares.document(shareOf(req).link, principalOf(req), documentId);
  }

  /** What accepting one of its PDFs means for the guest, and whether they may (B8). */
  @Get('acceptances/documents/:documentId')
  async acceptance(
    @Req() req: ShareRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query('lang') lang?: string,
  ): Promise<AcceptanceStatus> {
    const parsed = lang ? Lang.safeParse(lang) : undefined;
    if (parsed && !parsed.success)
      throw new BadRequestException({ error: 'bad_query', message: 'lang is en, hi or te' });
    await this.shares.declaredDocument(shareOf(req).link, documentId, { acceptable: true });
    return this.acceptances.status(principalOf(req), documentId, parsed?.data);
  }

  /** A code to the link's contact, to accept one of its PDFs (B8's acceptance.challenge). */
  @Post('acceptances/challenges')
  @HttpCode(200)
  async challenge(
    @Req() req: ShareRequest,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    const documentId = (body as { documentId?: unknown } | null)?.documentId;
    if (typeof documentId !== 'string')
      throw new BadRequestException({ error: 'invalid', message: 'Name the documentId' });
    await this.shares.declaredDocument(shareOf(req).link, documentId, { acceptable: true });
    return this.write(principalOf(req), meta, challengeOp(this.otp), body);
  }

  /** The acceptance's code entered: the PDF is accepted (B8's acceptance.accept). */
  @Post('acceptances')
  @HttpCode(200)
  async accept(
    @Req() req: ShareRequest,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult> {
    const p = principalOf(req);
    const input = AcceptInput.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const ch = await this.otp.get(input.data.challengeId);
    if (!ch || ch.purpose !== ACCEPTANCE_PURPOSE)
      throw new NotFoundException({ error: 'not_found', message: 'No such code' });
    const binding = ch.binding as unknown as Binding;
    await this.shares.declaredDocument(shareOf(req).link, binding.documentId, {
      acceptable: true,
    });
    const guessed = await guessCode(this.otp, p, input.data, { repeat: !!meta.idempotencyKey });
    const op = acceptOp(this.otp, { client: clientOf(req), requestId: meta.requestId, guessed });
    return this.write(p, meta, op, body);
  }

  /** A form link's answer: one new record of its entity (decisions B9, 17). */
  @Post('submit')
  @HttpCode(201)
  async submit(
    @Req() req: ShareRequest,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult> {
    const { link, verified } = shareOf(req);
    const form = link.kind === 'form' && link.form ? publicForms.get(link.form) : undefined;
    const def = form ? entityDef(form.entity) : undefined;
    if (!form || !def)
      throw new NotFoundException({ error: 'not_found', message: 'This link is not a form' });
    const answers = ShareSubmitInput.safeParse(body ?? {});
    if (!answers.success)
      throw new BadRequestException({ error: 'invalid', issues: answers.error.issues });
    // Only what the form asks, then what the server sets: nothing else of the request.
    const values: Values = {};
    for (const key of form.fields)
      if (answers.data.values[key] !== undefined) values[key] = answers.data.values[key];
    Object.assign(values, form.fixed ?? {});
    const custom = customForCreate(answers.data.custom);
    if (custom && (form.custom ?? def.spec.traits?.customFields !== undefined))
      values.custom = custom;
    const input = def.spec.schemas.create.safeParse(values);
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const p = await this.resolver.forShareLink(link, { verified, reach: 'form' });
    return this.write(p, meta, submitOp(def, link, form), values);
  }
}
