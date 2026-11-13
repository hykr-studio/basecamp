import type { Principal } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  PrincipalGuard,
  tenantMoney,
} from '@hykr/core';
import { Controller, ForbiddenException, Get, Inject, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';

/** How the caller's business counts money: what a client needs to show and enter amounts. */
export interface MoneyInfo {
  /** ISO 4217: the business's, else the deployment's DEFAULT_CURRENCY, else XXX. */
  currency: string;
  /** Decimals of its minor unit (2 for EUR, 0 for JPY). */
  exponent: number;
  /** The month its financial year starts, 1-12. */
  fyStartMonth: number;
  timeZone: string;
}

/**
 * GET /api/money: the caller's business's currency, its exponent and its financial year. The
 * named amounts and bands in its settings stay on the server, where the application's rules
 * read them.
 */
@Controller('api/money')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class MoneyController {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  @Get()
  async money(@CurrentPrincipal() p: Principal): Promise<MoneyInfo> {
    if (!p.tenantId) throw new ForbiddenException({ error: 'forbidden', rule: 'no_tenant' });
    const m = await tenantMoney(this.options.db, p.tenantId);
    return {
      currency: m.currency,
      exponent: m.exponent,
      fyStartMonth: m.fyStartMonth,
      timeZone: m.timeZone,
    };
  }
}
