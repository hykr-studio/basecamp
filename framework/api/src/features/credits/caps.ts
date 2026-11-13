// A cap as people call it: a meter's label in the reader's language. A refusal's reason, the
// credits status and a threshold event name a meter so, never by its name in the code.
import { type Labels, type Lang, languages, type MessageKey, pick, t } from '@hykr/i18n';
import type { MeterDef } from './meters.js';

/** The framework's meters, in its own phrases (framework/i18n, credits.ts). */
const FRAMEWORK_LABELS: Readonly<Record<string, MessageKey>> = {
  tokens: 'credits.meter.tokens',
  tool_calls: 'credits.meter.tool_calls',
  messages: 'credits.meter.messages',
  voice_seconds: 'credits.meter.voice_seconds',
  embedding_tokens: 'credits.meter.embedding_tokens',
};

/**
 * A meter as people call it, in this language: the label it declares, else the framework's
 * phrase for its own meters, else its name (a meter nobody named). Never 'tool_calls'.
 */
export function meterLabel(meter: Pick<MeterDef, 'name' | 'label'>, lang: Lang): string {
  if (meter.label) return pick(meter.label, lang);
  const key = FRAMEWORK_LABELS[meter.name];
  return key ? t(lang, key) : meter.name;
}

/** `meterLabel` in each of the application's languages: for words said later (an alert). */
export const meterLabels = (meter: Pick<MeterDef, 'name' | 'label'>): Labels =>
  Object.fromEntries(languages().codes.map((lang) => [lang, meterLabel(meter, lang)])) as Labels;
