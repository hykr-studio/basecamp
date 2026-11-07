// Accepting a record's PDF with a one-time code in the app (B8), and the hooks under it.
export { AcceptDocument, RecordAcceptance } from './AcceptDocument';
export {
  type AcceptanceClient,
  AcceptanceClientProvider,
  useAccept,
  useAcceptanceClient,
  useAcceptanceKinds,
  useAcceptanceStatus,
  useAcceptances,
  useRequestAcceptanceCode,
  useStartESign,
} from './hooks';
