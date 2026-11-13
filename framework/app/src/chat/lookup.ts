import { useAuiState } from '@assistant-ui/react-native';
import { writeToolIds } from '@hykr/contracts';
import { getCatalog } from '../runtime';
import { isLookup, type MessagePart } from './lookupOf';

/**
 * Whether this tool call only looked something up (`isLookup`): a read whose view came before a
 * write of the same reply ("delete Tiles": the list, then the request), or before the record it
 * found was shown or opened ("open Site review"). Its view is not shown: what it found is the
 * answer. While a reply streams, the view goes once the write is called or the record shows; a
 * reloaded thread saved it without one.
 */
export function useLookup(toolCallId: string): boolean {
  return useAuiState((s) =>
    isLookup(s.message.parts as readonly MessagePart[], toolCallId, writeToolIds(getCatalog())),
  );
}
