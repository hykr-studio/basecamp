// What can be metered, and how credits are bought: two registries a feature or module adds to
// through `contributes` (meters, creditPurchaseProviders). Nothing here reads the configuration.
import { createHookRegistry, MeterName } from '@hykr/contracts';
import type { CreditsPlanResolved } from './config.js';

declare module '@hykr/contracts' {
  interface Contributions {
    meters: readonly MeterDef[];
    creditPurchaseProviders: readonly CreditPurchaseProvider[];
  }
}

/** Something a business's use of is counted and priced. */
export interface MeterDef {
  /** Unique: 'tokens', 'messages', or a module's ('pages_rendered'). */
  name: string;
  /** Its base unit, as quantities are counted: 'token', 'call', 'message', 'second'. */
  unit: string;
  /** A price is per this many base units (1,000,000 tokens; 60 seconds). Default 1. */
  per?: number;
  /**
   * Whether a use of this variant is refused while the business is paused. Default: always.
   * Messages pause only the variants the plan names, so codes and replies always go.
   */
  pausable?(variant: string | null | undefined, plan: CreditsPlanResolved): boolean;
}

/** A meter, checked: its name and a positive `per`. */
export function defineMeter(def: MeterDef): MeterDef {
  MeterName.parse(def.name);
  if (def.per !== undefined && !(Number.isInteger(def.per) && def.per > 0))
    throw new Error(`Meter ${def.name}: per must be a positive whole number`);
  return def;
}

/** Every meter, by name: the framework's four and any contributed. */
export const meters = createHookRegistry<MeterDef>('meter', (m) => defineMeter(m).name, {
  collects: 'meters',
});

/** The framework's meters. The credits feature contributes them. */
export const FrameworkMeters = {
  /** The assistant's model tokens, input and output; the variant is the model's ref. */
  tokens: defineMeter({ name: 'tokens', unit: 'token', per: 1_000_000 }),
  /** Tools the assistant called in a turn. */
  toolCalls: defineMeter({ name: 'tool_calls', unit: 'call' }),
  /** WhatsApp messages the provider accepted; the variant is the template's category. */
  messages: defineMeter({
    name: 'messages',
    unit: 'message',
    pausable: (variant, plan) => !!variant && plan.pauseMessages.includes(variant),
  }),
  /** Voice session seconds, priced per minute. */
  voiceSeconds: defineMeter({ name: 'voice_seconds', unit: 'second', per: 60 }),
} as const;

/** What a purchase provider is asked to start. */
export interface PurchaseStart {
  purchase: { id: string; tenantId: string; amount: number; currency: string };
  /** The person buying. */
  userId: string;
}

/** What it answers: a checkout for the person, or the outcome at once. */
export interface PurchaseStarted {
  /** The provider's own id for the purchase. */
  ref?: string;
  /** Where the person pays. */
  checkoutUrl?: string;
  /** Settled already: an instant method, or refused. */
  status?: 'paid' | 'failed';
  reason?: string;
}

/**
 * How credits are paid for: a payment connector (B10) registers one. The framework records the
 * purchase and calls `start` once; the connector's confirmation (its verified webhook) calls
 * `CreditsService.settlePurchase(id, { status, ref })`. No provider ships with the framework.
 */
export interface CreditPurchaseProvider {
  /** Unique: the connector's name. */
  name: string;
  start(a: PurchaseStart): Promise<PurchaseStarted>;
}

/** Purchase providers, by name. */
export const creditPurchaseProviders = createHookRegistry<CreditPurchaseProvider>(
  'credit purchase provider',
  (p) => p.name,
  { collects: 'creditPurchaseProviders' },
);
