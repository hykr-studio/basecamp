import { useCallback, useState } from 'react';
import { errorMessage } from '../../framework/hooks';
import { currentLocation, type Fix, type FixAccuracy } from './location';

/**
 * The device's position on request: `locate()` asks for permission the first time, then
 * resolves with the fix (or null when it failed: `error` says why).
 */
export function useCurrentLocation(o: { accuracy?: FixAccuracy } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const accuracy = o.accuracy;
  const locate = useCallback(async (): Promise<Fix | null> => {
    setBusy(true);
    setError(null);
    try {
      const next = await currentLocation({ accuracy });
      setFix(next);
      return next;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [accuracy]);
  return { locate, fix, busy, error };
}
