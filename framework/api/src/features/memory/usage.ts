// Embeddings under credits: what memory recall and the indexer ask before they call the embedding
// model, and what they record after. Both go through the Metering slot; with the credits feature
// off, nothing is checked or recorded.
import type { UsageRefusal } from '@hykr/contracts';
import { metering } from '../../metering.js';
import { FrameworkMeters } from '../credits/meters.js';

/** The meter embeddings count against. */
export const EMBEDDING_METER = FrameworkMeters.embeddingTokens.name;

/**
 * May this business embed now? null: yes, or nothing meters it. Throws when the check itself
 * fails: the caller treats that as a refusal (fail closed).
 */
export async function embeddingRefusal(
  tenantId: string,
  model?: string,
): Promise<UsageRefusal | null> {
  const meter = metering();
  if (!meter) return null;
  return meter.check({ tenantId, meter: EMBEDDING_METER, variant: model ?? null });
}

/**
 * The tokens one embedding call used: what the provider reported, else (the AI SDK says NaN when
 * it reports nothing) an estimate of one token per four characters of each text, at least one per
 * text, so a gateway that reports no usage is not free.
 */
export function embeddingTokens(reported: number | undefined, texts: readonly string[]): number {
  if (reported !== undefined && Number.isFinite(reported) && reported > 0)
    return Math.ceil(reported);
  return texts.reduce((n, t) => n + Math.max(1, Math.ceil(t.length / 4)), 0);
}

/** One embedding call's tokens, recorded against the business. Never throws. */
export async function recordEmbedding(use: {
  tenantId: string;
  model: string;
  tokens: number;
  source: 'memory.recall' | 'memory.index';
  subject?: string | null;
  channel?: string | null;
  runId?: string | null;
}): Promise<void> {
  await metering()?.record({
    tenantId: use.tenantId,
    meter: EMBEDDING_METER,
    quantity: use.tokens,
    variant: use.model,
    source: use.source,
    subject: use.subject ?? null,
    channel: use.channel ?? null,
    runId: use.runId ?? null,
  });
}
