import { useAuiState } from '@assistant-ui/react-native';
import { lookupsIn } from '@hykr/contracts';

/**
 * Whether this tool call only looked something up (`lookupsIn` in @hykr/contracts): a read whose
 * view came before a write of the same reply ("delete Tiles": the list, then the request). Its
 * view is not shown: the write is the answer. While the reply streams, the view shows until the
 * write arrives; a reloaded thread saved it without one.
 */
export function useLookup(toolCallId: string): boolean {
  return useAuiState((s) => {
    const calls = (
      s.message.parts as readonly { type: string; toolCallId?: string; result?: unknown }[]
    ).filter((p) => p.type === 'tool-call');
    const at = calls.findIndex((p) => p.toolCallId === toolCallId);
    return at >= 0 && lookupsIn(calls.map((p) => p.result)).has(at);
  });
}
