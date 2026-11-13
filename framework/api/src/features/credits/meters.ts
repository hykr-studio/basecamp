// What can be metered, and how credits are bought: two registries a feature or module adds to
// through `contributes` (meters, creditPurchaseProviders). Nothing here reads the configuration.
import { priceOf } from '@hykr/agents';
import { createHookRegistry, MeterName } from '@hykr/contracts';
import type { Labels } from '@hykr/i18n';
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
  /**
   * What people call it, in each of the application's languages ('Pages rendered'): a refusal's
   * reason and the credits screen name it so. The framework's meters are named in its own
   * phrases (`credits.meter.<name>`); a meter with neither reads as its name.
   */
  label?: Labels;
  /** Its base unit, as quantities are counted: 'token', 'call', 'message', 'second'. */
  unit: string;
  /** A price is per this many base units (1,000,000 tokens; 60 seconds). Default 1. */
  per?: number;
  /**
   * Whether a use of this variant is refused while the business is paused. Default: always.
   * Messages pause only the variants the plan names, so codes and replies always go.
   */
  pausable?(variant: string | null | undefined, plan: CreditsPlanResolved): boolean;
  /**
   * The price per `per` units of a use neither the plan nor the deployment prices (by
   * '<meter>.<variant>' or '<meter>'): embedding tokens ask the model's own price. Undefined: the
   * use costs nothing.
   */
  fallbackPrice?(variant: string | null | undefined, plan: CreditsPlanResolved): number | undefined;
}

/** A meter, checked: its name and a positive `per`. */
export function defineMeter(def: MeterDef): MeterDef {
  MeterName.parse(def.name);
  if (def.per !== undefined && !(Number.isInteger(def.per) && def.per > 0))
    throw new Error(`Meter ${def.name}: per must be a positive whole number`);
  return def;
}

/**
 * A model's own input price per million tokens (MODEL_PROVIDERS) plus the deployment's markup,
 * when it is in the credits currency; otherwise undefined (another currency, an unpriced or
 * unknown model, or a registry that does not parse).
 */
export function modelInputPrice(
  ref: string | null | undefined,
  plan: Pick<CreditsPlanResolved, 'currency' | 'markupPercent'>,
): number | undefined {
  if (!ref || !plan.currency) return undefined;
  let own: ReturnType<typeof priceOf>;
  try {
    own = priceOf(ref);
  } catch {
    return undefined;
  }
  if (!own || own.currency !== plan.currency) return undefined;
  return own.inputPerMillion * (1 + plan.markupPercent / 100);
}

/** Every meter, by name: the framework's five and any contributed. */
export const meters = createHookRegistry<MeterDef>('meter', (m) => defineMeter(m).name, {
  collects: 'meters',
});

/** The framework's meters. The credits feature contributes them. */
export const FrameworkMeters = {
  /**
   * Model tokens, input and output: the assistant's turns, the guardrail's calls and embeddings
   * (memory recall and indexing). The variant is the model's ref.
   */
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
  /**
   * Tokens sent to an embedding model (memory recall and indexing); the variant is the model's
   * ref. Unpriced, it costs the model's own input price plus the markup.
   */
  embeddingTokens: defineMeter({
    name: 'embedding_tokens',
    unit: 'token',
    per: 1_000_000,
    fallbackPrice: modelInputPrice,
  }),
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
 * purchase and calls `start` once; the connector's confirmation (its verified webhook's handler)
 * calls `CreditsService.settlePurchase({ tenantId, provider, purchaseId }, { status, ref })` with
 * the connection's own business, so it settles only that business's purchases made with it. No
 * provider ships with the framework.
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
