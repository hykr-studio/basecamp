// The push feature's settings, read from the environment when used (never when a module loads).
// EXPO_BASE_URL, the push service's address, is read by expo-server-sdk itself.
const env = process.env;

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const pushSettings = {
  /** Expo's access token, when the Expo project requires one for sending (push security). */
  accessToken: () => env.EXPO_ACCESS_TOKEN || undefined,
  /** How old a send is before its receipt is asked for. Default a minute. */
  receiptDelayMs: () => positive(env.PUSH_RECEIPT_DELAY_MS, 60_000),
};
