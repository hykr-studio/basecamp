import { PermanentError, RetryableError } from '../adapter.js';

/** Graph codes that mean "slow down" (throughput, rate limits): try again later. */
const THROTTLED = new Set([4, 80007, 130429, 131056]);

/**
 * A failed Graph call, as one of two kinds: worth retrying (429, 5xx, throughput limits), or
 * not (a number not on WhatsApp, a template not approved, outside the 24-hour window, …). The
 * send queue retries only the first.
 */
export async function graphError(res: Response): Promise<Error> {
  const text = await res.text();
  let code: number | undefined;
  let message = text.slice(0, 300);
  try {
    const body = JSON.parse(text) as { error?: { code?: number; message?: string } };
    code = body.error?.code;
    message = body.error?.message ?? message;
  } catch {
    // Not JSON (a proxy's page): the status decides.
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  if (res.status === 429 || res.status >= 500 || (code !== undefined && THROTTLED.has(code)))
    return new RetryableError(`Graph ${res.status}: ${message}`, code, retryAfterMs);
  return new PermanentError(`Graph ${res.status}: ${message}`, code);
}
