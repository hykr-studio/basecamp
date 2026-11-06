import { randomUUID } from 'node:crypto';
import { CreditGrantInput, type CreditsStatus } from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions, runWrite, systemPrincipal } from '@hykr/core';
import { schema } from '@hykr/db';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import { parseOr400 } from './credits.controller.js';
import { CreditsService } from './credits.service.js';
import { OperatorGuard } from './operator.guard.js';
import {
  grantCredits,
  OPERATOR_JOB,
  OverrideInput,
  PlanInput,
  planProblems,
  setCreditsOverride,
  setCreditsPlan,
} from './writes.js';

/**
 * The platform operator's view of any business's credits (x-operator-key): its full status and
 * ledger, its plan, an override, and grants. Each write runs through the write path as the
 * operator's system job in that business, so it is audited there.
 */
@Controller('api/credits/operator/:tenantId')
@AllowAnonymous()
@UseGuards(OperatorGuard)
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
    tenantId: string,
    op: Parameters<typeof runWrite>[2],
    input: unknown,
    idempotencyKey?: string,
  ) {
    const principal = systemPrincipal({
      tenantId: await this.business(tenantId),
      job: OPERATOR_JOB,
    });
    const { result, events } = await runWrite(
      this.core.db,
      { principal, requestId: randomUUID(), ...(idempotencyKey ? { idempotencyKey } : {}) },
      op,
      input,
    );
    for (const event of events) this.events.publish(event);
    return result;
  }

  @Get()
  async status(@Param('tenantId') tenantId: string): Promise<CreditsStatus> {
    return this.credits.status(await this.business(tenantId), true);
  }

  @Get('ledger')
  async ledger(
    @Param('tenantId') tenantId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.credits.ledger(await this.business(tenantId), {
      ...(before ? { before } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  /** Replace the plan. Limits and prices for meters nobody registered are a 400. */
  @Put('settings')
  async settings(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    const plan = parseOr400(PlanInput, body, 'invalid_plan');
    const problems = planProblems(plan);
    if (problems.length) throw new BadRequestException({ error: 'invalid_plan', problems });
    return this.write(tenantId, setCreditsPlan(), plan, key);
  }

  /** Set the override (`{ override: { mode, until?, reason } }`), or clear it (`{ override: null }`). */
  @Put('override')
  async override(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.write(
      tenantId,
      setCreditsOverride(),
      parseOr400(OverrideInput, body, 'invalid_override'),
      key,
    );
  }

  @Post('grants')
  async grant(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.write(
      tenantId,
      grantCredits(),
      parseOr400(CreditGrantInput, body, 'invalid_grant'),
      key,
    );
  }
}
