import type { Me, Principal } from '@hykr/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard, TenantConfigService } from '@hykr/core';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { flagsOn } from '../../features/settings/gates.js';

/** Who the signed-in person is, in the business they are working in: roles and what they allow. */
@Controller('api/me')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class MeController {
  constructor(private readonly config: TenantConfigService) {}

  @Get()
  async me(@CurrentPrincipal() p: Principal): Promise<Me> {
    const { settings } = await this.config.get(p.tenantId ?? '');
    return {
      userId: p.actor.id,
      tenantId: p.tenantId ?? '',
      roles: p.roles ?? [],
      capabilities: p.capabilities ?? [],
      customerId: p.customerId ?? null,
      // The declared feature flags that are on here (A11): everything else is off.
      features: flagsOn(settings),
    };
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
