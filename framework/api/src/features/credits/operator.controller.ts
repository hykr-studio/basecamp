import { CreditGrantInput, type CreditsStatus, PlatformCapabilities } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
} from '@hykr/core';
import { schema } from '@hykr/db';
import { isLang } from '@hykr/i18n';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import {
  type ActingOperator,
  CurrentOperator,
  OperatorCan,
  OperatorGuard,
  operatorPrincipal,
} from '../platform/operators.js';
import { parseOr400 } from './credits.controller.js';
import { CreditsService } from './credits.service.js';
import {
  grantCredits,
  OPERATOR_JOB,
  OverrideInput,
  PlanInput,
  planAfter,
  planProblems,
  setCreditsOverride,
  setCreditsPlan,
} from './writes.js';

/**
 * A platform operator's view of any business's credits (a signed-in operator holding
 * `platform.credits`): its full status and ledger, its plan, an override, and grants. Each write
 * runs through the write path as the operator's system job in that business, on behalf of the
 * operator, so it is audited there.
 */
@Controller('api/credits/operator/:tenantId')
@OptionalAuth()
@UseGuards(OperatorGuard)
@OperatorCan(PlatformCapabilities.credits)
export class CreditsOperatorController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    private readonly credits: CreditsService,
  ) {}

  /** The business, or 404. */
  private async business(tenantId: string) {
    const [row] = await this.core.db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
    return row.id;
  }

  private async write(
    operator: ActingOperator,
    meta: RequestMetaValue,
    tenantId: string,
    op: Parameters<typeof runWrite>[2],
    input: unknown,
  ) {
    const principal = operatorPrincipal(await this.business(tenantId), OPERATOR_JOB, operator);
    const { result, events } = await runWrite(
      this.core.db,
      { principal, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input,
    );
    for (const event of events) this.events.publish(event);
    return result;
  }

  /** `?lang=`: the operator's language, for its words. */
  @Get()
  async status(
    @Param('tenantId') tenantId: string,
    @Query('lang') lang?: string,
  ): Promise<CreditsStatus> {
    return this.credits.status(await this.business(tenantId), true, isLang(lang) ? lang : 'en');
  }

  /** `?lang=`: the operator's language, for a debit's words. */
  @Get('ledger')
  async ledger(
    @Param('tenantId') tenantId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('lang') lang?: string,
  ) {
    return this.credits.ledger(await this.business(tenantId), {
      ...(before ? { before } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      lang: isLang(lang) ? lang : 'en',
    });
  }

  /** Replace the plan. Limits and prices for meters nobody registered are a 400. */
  @Put('settings')
  async settings(
    @CurrentOperator() operator: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    const plan = parseOr400(PlanInput, body, 'invalid_plan');
    // Checked as it will be stored: with the business's own alert threshold, when the plan
    // keeps it, so one that no longer fits is a 400 naming it.
    const [row] = await this.core.db
      .select({ settings: schema.tenants.settings })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    const stored = (row?.settings as { credits?: unknown } | null)?.credits;
    const before =
      stored && typeof stored === 'object' ? (stored as Parameters<typeof planAfter>[1]) : {};
    const problems = planProblems(planAfter(plan, before));
    if (problems.length) throw new BadRequestException({ error: 'invalid_plan', problems });
    return this.write(operator, meta, tenantId, setCreditsPlan(), plan);
  }

  /** Set the override (`{ override: { mode, until?, reason } }`), or clear it (`{ override: null }`). */
  @Put('override')
  async override(
    @CurrentOperator() operator: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    return this.write(
      operator,
      meta,
      tenantId,
      setCreditsOverride(),
      parseOr400(OverrideInput, body, 'invalid_override'),
    );
  }

  @Post('grants')
  async grant(
    @CurrentOperator() operator: ActingOperator,
    @RequestMeta() meta: RequestMetaValue,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ) {
    return this.write(
      operator,
      meta,
      tenantId,
      grantCredits(),
      parseOr400(CreditGrantInput, body, 'invalid_grant'),
    );
  }
}
