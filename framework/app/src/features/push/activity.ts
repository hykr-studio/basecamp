// Telling the server where the person is (W1): a push goes to the one device they used last.
// Reports are throttled, and a failed one is simply tried at the next use.

/** The fewest milliseconds between two reports from one device. */
export const ACTIVITY_EVERY_MS = 60_000;

/**
 * A reporter: `ping()` sends at most one report per `everyMs`; the first goes at once. `send`
 * failing is ignored (the next use tries again).
 */
export function activityReporter(
  send: () => Promise<unknown>,
  everyMs = ACTIVITY_EVERY_MS,
  now: () => number = Date.now,
) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    ping() {
      const t = now();
      if (t - last < everyMs) return false;
      last = t;
      void send().catch(() => {
        // Tried again at the next use.
        last = Number.NEGATIVE_INFINITY;
      });
      return true;
    },
  };
}
