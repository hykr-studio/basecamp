import type { Principal } from '@app/contracts';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
} from '../../common/principal.js';
import { TodosService } from './todos.service.js';

/** People only: the agent can never see or decide approvals. */
@Controller('api/approvals')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ApprovalsController {
  constructor(private readonly todos: TodosService) {}

  @Get()
  pending(@CurrentPrincipal() p: Principal) {
    return this.todos.pendingApprovals(p);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMeta,
  ) {
    return this.todos.decide(p, id, true, meta);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMeta,
  ) {
    return this.todos.decide(p, id, false, meta);
  }
}
