import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ApprovalsController } from './http/approvals.controller.js';
import { HumanOnlyGuard, PrincipalGuard } from './http/principal.js';
import { PrincipalResolver } from './http/resolver.js';
import { ShareGuard } from './http/share.guard.js';
import { UndoController } from './http/undo.controller.js';
import { setDefaultCurrency } from './money/tenant-money.js';
import { TenantConfigService } from './tenants/tenant-config.service.js';
import { setDefaultTimeZone } from './tenants/time-zone.js';
import { CORE_OPTIONS, type CoreOptions } from './tokens.js';
import { ApprovalService, setApprovalTtl } from './write/approvals.js';
import { setEventQueues } from './write/events.js';
import { UndoService } from './write/undo.js';

/**
 * The framework's shared pieces: the principal guards, approvals and undo, each business's settings,
 * and the database every generated handler uses. Import once in the app module, beside CqrsModule.forRoot().
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest's dynamic-module pattern (CoreModule.forRoot)
export class CoreModule {
  static forRoot(options: CoreOptions): DynamicModule {
    if (options.approvalTtlMs) setApprovalTtl(options.approvalTtlMs);
    if (options.queuePrefix) setEventQueues(options.queuePrefix);
    setDefaultCurrency(options.defaultCurrency);
    setDefaultTimeZone(options.defaultTimeZone);
    return {
      module: CoreModule,
      controllers: [ApprovalsController, UndoController],
      providers: [
        { provide: CORE_OPTIONS, useValue: options },
        PrincipalResolver,
        PrincipalGuard,
        HumanOnlyGuard,
        ShareGuard,
        ApprovalService,
        UndoService,
        TenantConfigService,
      ],
      exports: [
        CORE_OPTIONS,
        PrincipalResolver,
        PrincipalGuard,
        HumanOnlyGuard,
        ShareGuard,
        ApprovalService,
        UndoService,
        TenantConfigService,
      ],
    };
  }
}
