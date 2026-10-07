import type { Principal } from '@app/contracts';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { ApprovalService } from '../write/approvals.js';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
} from './principal.js';

/** People only: the agent can never see or decide approvals. Works for any parked command. */
@Controller('api/approvals')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ApprovalsController {
  constructor(@Inject(ApprovalService) private readonly approvals: ApprovalService) {}

  @Get()
  pending(@CurrentPrincipal() p: Principal) {
    return this.approvals.pending(p);
  }

  @Get(':id')
  one(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(p, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.approvals.decide(p, id, true, meta.requestId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.approvals.decide(p, id, false, meta.requestId);
  }
}
