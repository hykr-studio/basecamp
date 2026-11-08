import { CreditsManageCapability, CreditsViewCapability, reserveRoutes } from '@hykr/contracts';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineFeature } from '../feature.js';
import { OperatorGuard } from '../platform/operators.js';
import { CreditsController } from './credits.controller.js';
import { CreditsService } from './credits.service.js';
import { FrameworkMeters } from './meters.js';
import { CreditsOperatorController } from './operator.controller.js';
import { CreditsTurnHook } from './turn-hook.js';

// /api/credits and the operator's /api/credits/operator: no module may take the segment.
reserveRoutes('credits');

/** The sweep: raises alerts a plan change made due and re-arms levels no longer reached. */
export const CreditsAlertsQueue = defineQueue<unknown, number>({
  name: 'credits.alerts',
  process: async (_job, ctx) => ctx.get(CreditsService).sweep(),
});

export const CreditsSweep = defineSchedule({
  name: 'credits.sweep',
  queue: CreditsAlertsQueue.name,
  every: 10 * 60 * 1000,
});

/**
 * Credits and caps: every business's tokens, tool calls, messages, voice seconds and embedding
 * tokens metered and priced (CREDITS_CONFIG and its `credits` settings), a prepaid wallet with
 * its ledger, alerts and a pause as caps fill, an operator's override, and buying credits through
 * a purchase provider.
 */
export const creditsFeature = defineFeature({
  name: 'credits',
  controllers: [CreditsController, CreditsOperatorController],
  providers: [CreditsService, OperatorGuard],
  exports: [CreditsService],
  contributes: {
    capabilities: [CreditsViewCapability, CreditsManageCapability],
    meters: Object.values(FrameworkMeters),
    turnHooks: [CreditsTurnHook],
    queues: [CreditsAlertsQueue],
    schedules: [CreditsSweep],
  },
});

export { activeOverride, CreditsConfig, CreditsConfigError, creditsConfig } from './config.js';
export { CreditsService, CreditsThreshold } from './credits.service.js';
export {
  type CreditPurchaseProvider,
  creditPurchaseProviders,
  defineMeter,
  FrameworkMeters,
  type MeterDef,
  meters,
  type PurchaseStart,
  type PurchaseStarted,
} from './meters.js';
export {
  BUY_CREDITS,
  CreditPurchaseRequested,
  CreditPurchaseSettled,
  CreditsCredited,
  CreditsSettingsChanged,
  GRANT_CREDITS,
  SET_CREDIT_ALERTS,
  SET_CREDITS_OVERRIDE,
  SET_CREDITS_PLAN,
  SETTLE_PURCHASE,
} from './writes.js';
