import { useAuiState } from '@assistant-ui/react-native';
import { isLookup, type MessagePart } from './lookupOf';

/**
 * Whether this tool call only looked something up (`isLookup`): a read whose view came before a
 * write of the same reply ("delete Tiles": the list, then the request). Its view is not shown:
 * the write is the answer. While the reply streams, the view shows until the write arrives; a
 * reloaded thread saved it without one.
 */
export function useLookup(toolCallId: string): boolean {
  return useAuiState((s) => isLookup(s.message.parts as readonly MessagePart[], toolCallId));
}
