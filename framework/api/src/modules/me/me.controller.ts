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
    // The declared feature flags that are on here (A11): everything else is off. Settings that
    // do not parse switch every flag off (fail closed) but still answer, so a business whose
    // other section is broken keeps its roles and capabilities and can repair it (A4).
    const features = await this.config.get(p.tenantId ?? '').then(
      ({ settings }) => flagsOn(settings),
      () => [],
    );
    return {
      userId: p.actor.id,
      tenantId: p.tenantId ?? '',
      roles: p.roles ?? [],
      capabilities: p.capabilities ?? [],
      customerId: p.customerId ?? null,
      features,
    };
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
