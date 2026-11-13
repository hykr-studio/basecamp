// A resumed run's tool calls as thread parts, the way the chat service saves a turn's: what the
// chat renders (the outcome, what it showed, an approval, a refusal's reason), never the data.
import { randomUUID } from 'node:crypto';
import { compact, lookupsOf } from '../../modules/chat/chat.service.js';
import type { SavedPart } from '../../modules/threads/threads.service.js';

type RawToolResult = {
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: Parameters<typeof compact>[0];
};

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
