import { lookupsIn } from '@hykr/contracts';

/** A message part as assistant-ui keeps it: a tool call carries its tool, its id and its output. */
export type MessagePart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
};

/**
 * Whether this tool call of the message only looked something up (`lookupsIn` in
 * @hykr/contracts): a read whose view came before a write of the same reply (`writes`: the
 * catalog's write tools), or before a call that showed one of its rows. Its view is not shown;
 * what it found is the answer.
 */
export function isLookup(
  parts: readonly MessagePart[],
  toolCallId: string,
  writes?: ReadonlySet<string>,
): boolean {
  const calls = parts.filter((p) => p.type === 'tool-call');
  const at = calls.findIndex((p) => p.toolCallId === toolCallId);
  return (
    at >= 0 &&
    lookupsIn(
      calls.map((p) => ({ tool: p.toolName, output: p.result })),
      writes,
    ).has(at)
  );
}
