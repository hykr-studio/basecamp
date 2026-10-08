import type { Me, Principal } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';

/** Who the signed-in person is, in the business they are working in, with which roles. */
@Controller('api/me')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class MeController {
  @Get()
  me(@CurrentPrincipal() p: Principal): Me {
    return {
      userId: p.actor.id,
      tenantId: p.tenantId ?? '',
      roles: p.roles ?? [],
      customerId: p.customerId ?? null,
    };
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
