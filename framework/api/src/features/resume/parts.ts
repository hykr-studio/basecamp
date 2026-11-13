// A resumed run's tool calls as thread parts, the way the chat service saves a turn's: what the
// chat renders (the outcome, what it showed, an approval, a refusal's reason), never the data.
import { randomUUID } from 'node:crypto';
import type { Present } from '@hykr/contracts';
import { lookupsOf } from '../../modules/chat/chat.service.js';
import type { SavedPart } from '../../modules/threads/threads.service.js';

type RawToolResult = {
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: {
    ok?: boolean;
    present?: Present;
    speech?: string;
    result?: { status?: string; approval?: unknown };
    error?: { reason?: string; message?: unknown } | null;
  };
};

/** A lookup (`lookupsIn`) shows nothing, so it keeps no view. */
function compact(result: RawToolResult['result'], lookup: boolean) {
  if (!result) return null;
  const { ok, present, speech, error } = result;
  const r = result.result;
  return {
    ok,
    ...(present && !lookup ? { present } : {}),
    ...(speech && !lookup ? { speech } : {}),
    ...(error ? { error: { reason: error.reason, message: error.message } } : {}),
    ...(r?.status ? { result: { status: r.status, approval: r.approval } } : {}),
  };
}

/** Each tool result (Mastra's chunks) as a saved UI part: a lookup without its view. */
export function partsOf(results: readonly unknown[]): SavedPart[] {
  const raw = results.map(
    (r) => (r && typeof r === 'object' && 'payload' in r ? r.payload : r) as RawToolResult,
  );
  const lookups = lookupsOf(raw);
  return raw.map((x, i) => ({
    type: `tool-${x.toolName ?? 'tool'}`,
    toolCallId: x.toolCallId ?? randomUUID(),
    state: 'output-available',
    input: x.args ?? {},
    output: compact(x.result, lookups.has(i)),
  }));
}
