// A run that reaches its business's credit cap in the middle (H3): the API refuses the agent's
// next call with 402 `credits_paused`, and this processor ends the run there. The step after the
// refusal runs on a fixed model that says the paused sentence, with no tools, so the run makes no
// further call and spends no further tokens. Every surface shares the assistant, so a chat turn,
// a WhatsApp or voice turn, an agent's run and a resumed run all stop the same way.
import type { LanguageModelV2, LanguageModelV2Content } from '@ai-sdk/provider';
import { pausedSentenceKey } from '@hykr/contracts';
import { isLang, type Lang, t } from '@hykr/i18n';
import type { ProcessInputStepArgs, Processor } from '@mastra/core/processors';

/** The refusal a paused business's agent gets from the API, as a tool's result carries it. */
export function isPausedRefusal(output: unknown): boolean {
  const o = output as { ok?: unknown; status?: unknown; error?: { error?: unknown } } | null;
  return !!o && o.ok === false && o.status === 402 && o.error?.error === 'credits_paused';
}

/**
 * A tool result's output, in the shapes the agent loop keeps them in: a step's `tool-result`
 * part (`output: { type: 'json', value }`), or a stream chunk's payload.
 */
function outputOf(part: unknown): unknown {
  const p = part as { output?: unknown; result?: unknown; payload?: { result?: unknown } } | null;
  const out = p?.payload?.result ?? p?.result ?? p?.output;
  const typed = out as { type?: unknown; value?: unknown } | null;
  return typed && typeof typed === 'object' && 'value' in typed && typeof typed.type === 'string'
    ? typed.value
    : out;
}

/**
 * The first refusal of the run so far that came back because the business is paused: its rule
 * (`credits_suspended`, the operator's pause, or the credits used or a limit reached). Null when
 * none did.
 */
export function pausedRefusalIn(steps: readonly unknown[]): { rule?: unknown } | null {
  for (const step of steps) {
    const s = step as { toolResults?: unknown[]; content?: { type?: string }[] } | null;
    const results = [
      ...(s?.toolResults ?? []),
      ...(s?.content ?? []).filter((c) => c?.type === 'tool-result'),
    ];
    for (const r of results) {
      const out = outputOf(r);
      if (isPausedRefusal(out)) return { rule: (out as { error: { rule?: unknown } }).error.rule };
    }
  }
  return null;
}

/** Did a tool of the run so far come back refused because the business is paused? */
export const pausedIn = (steps: readonly unknown[]): boolean => pausedRefusalIn(steps) !== null;

/** A model that only ever says these words, for nothing: the run's last step. */
export function sayingModel(text: string): LanguageModelV2 {
  const content: LanguageModelV2Content[] = [{ type: 'text', text }];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    specificationVersion: 'v2',
    provider: 'basecamp',
    modelId: 'paused',
    supportedUrls: {},
    async doGenerate() {
      return { content, finishReason: 'stop', usage, warnings: [] };
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'paused' });
            controller.enqueue({ type: 'text-delta', id: 'paused', delta: text });
            controller.enqueue({ type: 'text-end', id: 'paused' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
      };
    },
  };
}

/**
 * The paused sentence in the turn's language (the one a refused turn says): the operator's
 * pause (`rule` `credits_suspended`) has its own, as adding credits does not lift it.
 */
export const pausedText = (lang: unknown, rule?: unknown) =>
  t((isLang(lang) ? lang : 'en') as Lang, pausedSentenceKey(rule));

/**
 * Before each step of a run: once a tool has come back refused because the business is paused,
 * the step says the paused sentence and nothing else (no tools), which ends the run.
 */
export class EndWhenPaused implements Processor {
  readonly id = 'end-when-paused';
  readonly name = 'End the run when the business is paused';

  processInputStep({ steps, requestContext }: ProcessInputStepArgs) {
    const refused = pausedRefusalIn(steps);
    if (!refused) return undefined;
    return {
      model: sayingModel(pausedText(requestContext?.get('lang'), refused.rule)),
      tools: {},
      toolChoice: 'none' as const,
    };
  }
}
