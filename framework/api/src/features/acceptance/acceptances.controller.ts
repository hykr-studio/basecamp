import {
  type AcceptanceInfo,
  type AcceptanceKindInfo,
  type AcceptanceStatus,
  AcceptInput,
  type ESignStarted,
  Lang,
  type Principal,
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
import { documents, files } from '@hykr/db';
import {
  BadGatewayException,
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import { OtpService } from '../../channels/otp/otp.service.js';
import { FilesService } from '../files/files.service.js';
import { AcceptanceService } from './acceptance.service.js';
import { type Binding, signerOf } from './checks.js';
import { esignProviders } from './esign.js';
import {
  acceptOp,
  type ChallengeMeta,
  type ClientInfo,
  challengeOp,
  esignOp,
  guessCode,
} from './ops.js';

type Incoming = {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

const header = (req: Incoming, name: string, max: number) => {
  const v = req.headers[name];
  const text = Array.isArray(v) ? v.join(', ') : v;
  return text ? text.slice(0, max) : null;
};

/** The request's address, x-forwarded-for as sent, and user agent (decisions B8, 21). */
const clientOf = (req: Incoming): ClientInfo => ({
  ip: req.ip ?? null,
  forwardedFor: header(req, 'x-forwarded-for', 300),
  userAgent: header(req, 'user-agent', 500),
});

/**
 * Accepting a record's PDF with a one-time code (docs/decisions/B8.md), people only: what would
 * be accepted, asking for a code, accepting with it, signing at an e-sign provider, and reading
 * a record's acceptances. Everything is reached through the record: another business, or a
 * record the caller does not reach, is 404.
 */
@Controller('api/acceptances')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class AcceptancesController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
    private readonly acceptances: AcceptanceService,
  ) {}

  private get otp(): OtpService {
    return this.ref.get(OtpService, { strict: false });
  }

  private async write<I>(
    p: Principal,
    meta: RequestMetaValue,
    // biome-ignore lint/suspicious/noExplicitAny: each operation's own loaded and value types
    op: WriteOp<I, any, any>,
    body: unknown,
  ): Promise<WriteResult> {
    const input = op.input.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const { result, events } = await runWrite(
      this.options.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input.data,
    );
    for (const event of events) this.events.publish(event);
    return result;
  }

  /** The acceptances an entity's records have (every one when none is named). */
  @Get('kinds')
  kinds(@Query('entity') entity?: string): { items: AcceptanceKindInfo[] } {
    return { items: this.acceptances.kinds(entity || undefined) };
  }

  /** One PDF: what accepting it means, where a code would go, and whether the caller may. */
  @Get('documents/:documentId')
  status(
    @CurrentPrincipal() p: Principal,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query('lang') lang?: string,
  ): Promise<AcceptanceStatus> {
    const parsed = lang ? Lang.safeParse(lang) : undefined;
    if (parsed && !parsed.success)
      throw new BadRequestException({ error: 'bad_query', message: 'lang is en, hi or te' });
    return this.acceptances.status(p, documentId, parsed?.data);
  }

  /** A record's acceptances the caller may see, newest first. */
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query('entity') entity?: string,
    @Query('id') id?: string,
  ): Promise<{ items: AcceptanceInfo[] }> {
    if (!entity || !id)
      throw new BadRequestException({
        error: 'bad_query',
        message: 'Name the record: ?entity=<entity>&id=<id>',
      });
    return { items: await this.acceptances.list(p, entity, id) };
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.acceptances.get(p, id);
  }

  /** A code to the signer's own number or email, for one PDF (acceptance.challenge). */
  @Post('challenges')
  @HttpCode(200)
  challenge(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.write(p, meta, challengeOp(this.otp), body);
  }

  /**
   * The code received: the PDF is accepted (acceptance.accept). The guess is made first, with no
   * transaction open (decisions B8, 11): a wrong one never reaches the write, and no request
   * holds two connections.
   */
  @Post()
  @HttpCode(200)
  async accept(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
    @Req() req: Incoming,
  ): Promise<WriteResult> {
    const input = AcceptInput.safeParse(body ?? {});
    if (!input.success)
      throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
    const guessed = await guessCode(this.otp, p, input.data, { repeat: !!meta.idempotencyKey });
    const op = acceptOp(this.otp, { client: clientOf(req), requestId: meta.requestId, guessed });
    return this.write(p, meta, op, body);
  }

  /** Sign at the acceptance's e-sign provider (acceptance.esign): where the signer goes. */
  @Post('esign')
  @HttpCode(200)
  async esign(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @RequestMeta() meta: RequestMetaValue,
  ): Promise<WriteResult> {
    const result = await this.write(p, meta, esignOp(this.otp), body);
    if (result.status !== 'done') return result;
    const pending = await this.otp.get((result.value as { id: string }).id);
    if (!pending) return result;
    const known = pending.meta as unknown as ChallengeMeta;
    // A repeat of the same request (its idempotency key) answers with the signing it started.
    if (known.ref)
      return { status: 'done', value: this.started(pending.id, pending.address, known) };
    const provider = esignProviders.get(pending.address);
    const binding = pending.binding as unknown as Binding;
    const [doc] = await this.options.db
      .select()
      .from(documents)
      .where(eq(documents.id, binding.documentId));
    if (!provider || !doc)
      throw new BadGatewayException({
        error: 'esign_unavailable',
        message: 'Signing is unavailable',
      });
    const signer = await signerOf(this.options.db, p);
    let started: Awaited<ReturnType<typeof provider.start>>;
    try {
      started = await provider.start({
        tenantId: pending.tenantId,
        requestId: pending.id,
        acceptance: binding.acceptance,
        document: {
          id: doc.id,
          name: doc.name,
          version: doc.version,
          sha256: binding.sha256,
          fileName: doc.fileName,
          bytes: async () => {
            const [file] = doc.fileId
              ? await this.options.db.select().from(files).where(eq(files.id, doc.fileId))
              : [];
            if (!file) throw new Error('The document has no file');
            return this.ref.get(FilesService, { strict: false }).bytesOf(file);
          },
        },
        signer: {
          name: signer?.name ?? null,
          phone: signer?.whatsapp ?? null,
          email: signer?.email ?? null,
        },
        statement: known.statement,
        lang: known.lang,
      });
    } catch {
      throw new BadGatewayException({
        error: 'esign_unavailable',
        message: 'The signing service did not answer: try again',
      });
    }
    const patch = {
      ref: started.ref,
      url: started.url ?? null,
      expiresAt: started.expiresAt?.toISOString() ?? null,
    };
    await this.otp.annotate(pending.id, patch);
    return { status: 'done', value: this.started(pending.id, pending.address, patch) };
  }

  private started(
    id: string,
    provider: string,
    m: Pick<ChallengeMeta, 'ref' | 'url' | 'expiresAt'>,
  ): ESignStarted {
    return {
      id,
      provider,
      ref: m.ref ?? '',
      url: m.url ?? null,
      expiresAt: m.expiresAt ?? null,
    };
  }
}
