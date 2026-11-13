// The meter the channels report to: what the outbound service and the voice service call to
// check a business's caps and record what it used. The credits feature fills the slot when it
// starts (setMetering); with nothing in it, nothing is metered or capped. Nothing here reads
// the configuration or loads Nest.
import type { UsageRefusal } from '@hykr/contracts';
import type { Lang } from '@hykr/i18n';

/** One use of something metered. */
export interface UsageInput {
  tenantId: string;
  /**
   * A registered meter: 'tokens', 'tool_calls', 'messages', 'voice_seconds', 'embedding_tokens'.
   */
  meter: string;
  /** In the meter's base unit. Zero or less records nothing. */
  quantity: number;
  /** The model for tokens and embedding tokens, a template's category for messages. */
  variant?: string | null;
  /**
   * A cost already worked out (credits); otherwise the business's prices give it. A `tokens` use
   * is priced as model tokens: `tokens.<variant>`, then `tokens`, then the model's own price.
   */
  cost?: number;
  /** For `tokens`: how many were input and output, for a model's own prices. Default: all input. */
  tokens?: { inputTokens?: number; outputTokens?: number };
  /** Whom it was for: 'user:<id>' or 'contact:<id>'. */
  subject?: string | null;
  runId?: string | null;
  channel?: string | null;
  /** What recorded it: 'turn', 'outbound', 'voice', a feature's name. */
  source: string;
  /** Unique per meter and business: the same use recorded twice counts once. */
  ref?: string | null;
}

export interface Metering {
  /**
   * May this business use this meter now? null: yes; otherwise why not, its reason in `lang`
   * (the reader's; English without it).
   */
  check(a: {
    tenantId: string;
    meter: string;
    variant?: string | null;
    lang?: Lang;
  }): Promise<UsageRefusal | null>;
  /** How much of this meter is left before the business is paused; undefined: no cap. */
  headroom(a: { tenantId: string; meter: string }): Promise<number | undefined>;
  /** Record uses, in one transaction. Never throws: a failure is logged. */
  record(uses: UsageInput | readonly UsageInput[]): Promise<void>;
}

/** A use the business's caps refuse now: a feature throws it where it would have called out. */
export class UsageRefused extends Error {
  constructor(readonly refusal: UsageRefusal) {
    super(refusal.reason);
    this.name = 'UsageRefused';
  }
}

let current: Metering | undefined;

/** Install (or, with nothing, remove) the meter. */
export function setMetering(m?: Metering) {
  current = m;
}

/** The installed meter, if any. */
export const metering = (): Metering | undefined => current;
