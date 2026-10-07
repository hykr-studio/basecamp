import type { Principal } from '@app/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { CurrentPrincipal, PrincipalGuard } from '../common/principal.js';

@Controller()
export class HealthController {
  @Get('health')
  @AllowAnonymous()
  health() {
    return { ok: true };
  }

  /** Who the API thinks is calling: a quick check of the principal guard. */
  @Get('me')
  @OptionalAuth()
  @UseGuards(PrincipalGuard)
  me(@CurrentPrincipal() principal: Principal) {
    return principal;
  }
}
