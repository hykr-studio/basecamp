import {
  CreditAlertsInput,
  type CreditPurchase,
  CreditsManageCapability,
  type CreditsStatus,
  CreditsViewCapability,
  type Principal,
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
} from '@hykr/core';
import { can } from '@hykr/policy';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { z } from 'zod';
import { CreditsService } from './credits.service.js';
import { buyCredits, planProblems, setCreditAlerts } from './writes.js';

/** A body that does not parse: 400 with every problem. */
export function parseOr400<T>(schema: z.ZodType<T>, body: unknown, error: string): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success)
    throw new BadRequestException({
      error,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
    });
  return parsed.data;
}

function need(p: Principal, capability: typeof CreditsViewCapability, rule: string, what: string) {
  if (!can(p, capability))
    throw new ForbiddenException({ error: 'forbidden', rule, reason: `Only ${what}` });
}

/**
 * A business's credits, for its people: whether it is paused and how much of each cap it used
 * (`credits.view`), and, for those who manage them (`credits.manage`), the amounts, the ledger,
 * buying credits and the alert threshold. People only: the assistant never reads or buys them.
 */
@Controller('api/credits')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class CreditsController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    private readonly credits: CreditsService,
  ) {}

  @Get()
  status(@CurrentPrincipal() p: Principal): Promise<CreditsStatus> {
    need(p, CreditsViewCapability, 'credits_view', "the business's team can see its usage");
    return this.credits.status(p.tenantId as string, can(p, CreditsManageCapability));
  }

  @Get('ledger')
  ledger(
    @CurrentPrincipal() p: Principal,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    need(p, CreditsManageCapability, 'credits_manage', 'people who manage the credits see this');
    return this.credits.ledger(p.tenantId as string, {
      ...(before ? { before } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  @Get('usage')
  usage(@CurrentPrincipal() p: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    need(p, CreditsManageCapability, 'credits_manage', 'people who manage the credits see this');
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 31 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
      throw new BadRequestException({
        error: 'invalid_range',
        reason: 'from and to are ISO times',
      });
    return this.credits.usage(p.tenantId as string, start, end);
  }

  @Get('purchases/:id')
  purchase(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<CreditPurchase> {
    need(p, CreditsManageCapability, 'credits_manage', 'people who manage the credits see this');
    return this.credits.purchase(p.tenantId as string, id);
  }

  /**
   * Buy credits: recorded through the write path (a write hook may park it), then its purchase
   * provider starts it. The answer carries the checkout (or the outcome, for an instant one).
   */
  @Post('purchases')
  async buy(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    const { result, events } = await runWrite(
      this.core.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      buyCredits(),
      body ?? {},
    );
    if (result.status === 'done') {
      const id = (result.value as CreditPurchase).id;
      await this.credits.checkout(id);
      for (const event of events) this.events.publish(event);
      return { ...result, value: await this.credits.purchase(p.tenantId as string, id) };
    }
    for (const event of events) this.events.publish(event);
    return result;
  }

  /** The business's own alert threshold (per cent), at most its pause threshold. */
  @Put('alerts')
  async alerts(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    const input = parseOr400(CreditAlertsInput, body, 'invalid_alerts');
    const stored = (await this.credits.tenantInfo(p.tenantId as string).catch(() => undefined))
      ?.settings.credits;
    const problems = planProblems({ ...(stored ?? {}), alertAt: input.alertAt });
    if (problems.length) throw new BadRequestException({ error: 'invalid_alerts', problems });
    const { result, events } = await runWrite(
      this.core.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      setCreditAlerts(),
      input,
    );
    for (const event of events) this.events.publish(event);
    return result;
  }
}
