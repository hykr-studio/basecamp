// The platform tier above the businesses (B19, docs/decisions/B19.md): named operators, support
// access a business consents to (time-boxed, logged, audited on behalf of the operator), making a
// business for a person, platform-managed flags, platform scope for the shared records, a routing
// hook for inbound requests, and a usage report across businesses. No routing rules, plans or
// prices: those are the application's.
import { reserveRoutes, SharedPublishCapability, SupportConsentCapability } from '@hykr/contracts';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { defineFeature } from '../feature.js';
import { OperatorGuard } from './operators.js';
import { PlatformController, PlatformMeController } from './platform.controller.js';
import { PlatformInboundHook, PlatformRoutingService } from './routing.js';
import { platformScopeHook, platformScopePlugin, platformScopeStanding } from './scope.js';
import { SupportAccessController } from './support.controller.js';
import {
  FRAMEWORK_WITHHELD,
  SupportLogInterceptor,
  supportReadOnlyHook,
  supportStanding,
} from './support.js';

// /api/platform (operators) and /api/support-access (a business's side) are the framework's.
reserveRoutes('platform', 'support-access');

export const platformFeature = defineFeature({
  name: 'platform',
  controllers: [PlatformMeController, PlatformController, SupportAccessController],
  providers: [
    OperatorGuard,
    PlatformRoutingService,
    PlatformInboundHook,
    { provide: APP_INTERCEPTOR, useClass: SupportLogInterceptor },
  ],
  exports: [OperatorGuard, PlatformRoutingService],
  contributes: {
    capabilities: [SupportConsentCapability, SharedPublishCapability],
    standingProviders: [supportStanding, platformScopeStanding],
    entityPlugins: [platformScopePlugin],
    writeHooks: [supportReadOnlyHook, platformScopeHook],
    supportWithheld: FRAMEWORK_WITHHELD,
  },
});

export {
  type ActingOperator,
  CurrentOperator,
  OperatorCan,
  OperatorGuard,
  operatorOf,
  operatorPrincipal,
} from './operators.js';
export {
  defineInboundRouter,
  type InboundRequest,
  type InboundRouter,
  inboundRouters,
  PlatformRoutingService,
  ROUTE_JOB,
  type RouteContext,
  type RouteTarget,
} from './routing.js';
export { SupportEvent, supportWithheld } from './support.js';
export { TenantProvisioned } from './tenants.js';
