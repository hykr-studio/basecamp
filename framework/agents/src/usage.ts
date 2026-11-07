// Model calls a turn makes besides its reply (H3): the guardrail's. Their tokens are reported to a
// sink the deployment fills (the API's credits feature records them under the business), so a
// business pays for every model call made for it. With no sink, or no business, nothing is said.
import { wrapLanguageModel } from 'ai';
import type { LanguageModel } from './models/registry.js';

/** One model call's tokens, for whom and why. */
export interface ModelUsage {
  tenantId: string;
  /** The model's ref ('<provider>/<model>'). */
  model: string;
  /** What called it: 'guardrail'. */
  source: string;
  inputTokens: number;
  outputTokens: number;
  /** 'user:<id>' or 'contact:<id>': whom the turn is for. */
  subject?: string;
  runId?: string;
  channel?: string;
}

export type ModelUsageSink = (usage: ModelUsage) => void | Promise<void>;

let sink: ModelUsageSink | undefined;

/** Install (or, with nothing, remove) where model usage goes. */
export function setModelUsageSink(next?: ModelUsageSink) {
  sink = next;
}

/** Report one call's usage; never throws (metering must not fail the turn). */
export async function reportModelUsage(usage: ModelUsage): Promise<void> {
  if (!sink || !usage.tenantId || usage.inputTokens + usage.outputTokens <= 0) return;
  try {
    await sink(usage);
  } catch {
    // The sink logs its own failures.
  }
}

/** A count as a provider reports it: a number (v2), or `{ total }` (v3 and later). */
const count = (x: unknown): number => {
  if (typeof x === 'number') return x;
  const total = (x as { total?: unknown } | null)?.total;
  return typeof total === 'number' ? total : 0;
};

type Ctx = { requestContext?: { get(key: string): unknown } };

/** Whom a turn's model calls are for, from its request context. */
export function usageContext({ requestContext }: Ctx) {
  const get = (key: string) => {
    const v = requestContext?.get(key);
    return typeof v === 'string' && v ? v : undefined;
  };
  return {
    tenantId: get('tenantId'),
    subject: get('actingFor'),
    runId: get('runId'),
    channel: get('channel'),
  };
}

/**
 * The model, reporting what each call of it used: its generate and its stream (at the stream's
 * finish), with the turn's business, person, run and channel. Without a business (Studio, an
 * eval with none) it is the model as it is.
 */
export function meteredModel(
  model: LanguageModel,
  of: { ref: string; source: string },
  ctx: Ctx,
): LanguageModel {
  const who = usageContext(ctx);
  const tenantId = who.tenantId;
  if (!tenantId) return model;
  const report = (usage: unknown) => {
    const u = usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    return reportModelUsage({
      tenantId,
      model: of.ref,
      source: of.source,
      inputTokens: count(u?.inputTokens),
      outputTokens: count(u?.outputTokens),
      ...(who.subject ? { subject: who.subject } : {}),
      ...(who.runId ? { runId: who.runId } : {}),
      ...(who.channel ? { channel: who.channel } : {}),
    });
  };
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        await report(result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        const counted = stream.pipeThrough(
          new TransformStream({
            async transform(part, controller) {
              if ((part as { type?: string }).type === 'finish')
                await report((part as { usage?: unknown }).usage);
              controller.enqueue(part);
            },
          }),
        );
        return { stream: counted, ...rest };
      },
    },
  }) as LanguageModel;
}
