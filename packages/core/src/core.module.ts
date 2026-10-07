import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ApprovalsController } from './http/approvals.controller.js';
import { HumanOnlyGuard, PrincipalGuard } from './http/principal.js';
import { CORE_OPTIONS, type CoreOptions } from './tokens.js';
import { ApprovalService, setApprovalTtl } from './write/approvals.js';

/**
 * The framework's shared pieces: the principal guards, approvals, and the database every
 * generated handler uses. Import once in the app module, beside CqrsModule.forRoot().
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest's dynamic-module pattern (CoreModule.forRoot)
export class CoreModule {
  static forRoot(options: CoreOptions): DynamicModule {
    if (options.approvalTtlMs) setApprovalTtl(options.approvalTtlMs);
    return {
      module: CoreModule,
      controllers: [ApprovalsController],
      providers: [
        { provide: CORE_OPTIONS, useValue: options },
        PrincipalGuard,
        HumanOnlyGuard,
        ApprovalService,
      ],
      exports: [CORE_OPTIONS, PrincipalGuard, HumanOnlyGuard, ApprovalService],
    };
  }
}
