// /api/support-access: a business's side of support access (B19). Its people holding
// `support.consent` see what the platform's operators asked, consent (as asked, shorter, or
// read-only), decline, end it, read what was done under it, and say how operators may ask.
import {
  type Principal,
  type SupportActivity,
  SupportConsentCapability,
  SupportConsentInput,
  type SupportGrant,
  type SupportSettings,
  SupportSettingsInput,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  requireCapability,
  runWrite,
  TenantConfigService,
  type WriteOp,
} from '@hykr/core';
import { supportGrants } from '@hykr/db';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, eq } from 'drizzle-orm';
import { parsed } from './parse.js';
import {
  activityOf,
  consentSupport,
  declineSupport,
  endSupport,
  grantsWhere,
  setSupportSettings,
} from './support.js';

// biome-ignore lint/suspicious/noExplicitAny: any write op
type AnyOp = WriteOp<any, any, any>;

const need = (p: Principal) =>
  requireCapability(p, SupportConsentCapability, {
    rule: 'support_consent',
    reason: 'Only people who decide on support access see it',
  });

@Controller('api/support-access')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class SupportAccessController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(TenantConfigService) private readonly tenantConfig: TenantConfigService,
  ) {}

  private async write(p: Principal, meta: RequestMetaValue, op: AnyOp, input: unknown) {
    const { result, events } = await runWrite(
      this.core.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input ?? {},
    );
    for (const event of events) this.events.publish(event);
    return result;
  }

  /** Every request for support access to this business, newest first. */
  @Get()
  list(@CurrentPrincipal() p: Principal): Promise<SupportGrant[]> {
    need(p);
    return grantsWhere(this.core.db, eq(supportGrants.tenantId, p.tenantId ?? ''));
  }

  @Get('settings')
  async settings(@CurrentPrincipal() p: Principal): Promise<SupportSettings> {
    need(p);
    return this.tenantConfig.section(p.tenantId ?? '', 'support');
  }

  /** How operators may ask: the whole `support` section. */
  @Put('settings')
  async setSettings(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    try {
      return await this.write(p, meta, setSupportSettings(), parsed(SupportSettingsInput, body));
    } finally {
      if (p.tenantId) this.tenantConfig.invalidate(p.tenantId);
    }
  }

  @Get(':id')
  async one(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    need(p);
    const [grant] = await grantsWhere(
      this.core.db,
      and(eq(supportGrants.id, id), eq(supportGrants.tenantId, p.tenantId ?? '')),
      1,
    );
    if (!grant)
      throw new NotFoundException({ error: 'not_found', message: 'No such support access' });
    return grant;
  }

  /** Every request made under it, newest first. */
  @Get(':id/activity')
  async activity(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportActivity[]> {
    await this.one(p, id);
    return activityOf(this.core.db, id);
  }

  @Post(':id/consent')
  @HttpCode(200)
  consent(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.write(p, meta, consentSupport(id), parsed(SupportConsentInput, body));
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.write(p, meta, declineSupport(id), {});
  }

  /** End it now, asked or active. */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.write(p, meta, endSupport(id, 'business'), {});
  }
}
