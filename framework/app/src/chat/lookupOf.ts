import { lookupsIn } from '@hykr/contracts';

/** A message part as assistant-ui keeps it: a tool call carries its id and its output. */
export type MessagePart = { type: string; toolCallId?: string; result?: unknown };

/**
 * Whether this tool call of the message only looked something up (`lookupsIn` in
 * @hykr/contracts): a read whose view came before a write of the same reply. Its view is not
 * shown; the write is the answer.
 */
export function isLookup(parts: readonly MessagePart[], toolCallId: string): boolean {
  const calls = parts.filter((p) => p.type === 'tool-call');
  const at = calls.findIndex((p) => p.toolCallId === toolCallId);
  return at >= 0 && lookupsIn(calls.map((p) => p.result)).has(at);
}
