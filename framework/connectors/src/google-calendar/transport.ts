// How the Google Calendar connector reaches Google: one function per request, so a fake (tests,
// offline development) replaces the network without touching the client.

/** One request to Google. */
export interface GoogleRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON, or a form for the OAuth endpoints. */
  body?: string;
}

/** Google's answer: the status and the body, parsed when it is JSON. */
export interface GoogleResponse {
  status: number;
  body: unknown;
}

export type GoogleTransport = (req: GoogleRequest) => Promise<GoogleResponse>;

/** Where Google is. Deployment settings may point them elsewhere (a proxy, a test double). */
export interface GoogleEndpoints {
  /** The consent screen. */
  auth: string;
  token: string;
  revoke: string;
  /** The Calendar API, without a trailing slash. */
  api: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/calendar/v3',
};

/** Google over the network, with a timeout per request. */
export function fetchTransport(options: { timeoutMs?: number } = {}): GoogleTransport {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (req) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body: text ? body : null };
  };
}

/** A refusal or failure from Google: its HTTP status and Google's reason, when it gave one. */
export class GoogleApiError extends Error {
  override readonly name = 'GoogleApiError';
  constructor(
    readonly status: number,
    /** Google's `error` (OAuth: 'invalid_grant') or the first error's `reason`. */
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** The error Google's body names, if any: OAuth's { error } or the API's { error: { errors } }. */
export function googleError(status: number, body: unknown, what: string): GoogleApiError {
  const b = (body ?? {}) as {
    error?: string | { message?: string; errors?: { reason?: string }[]; status?: string };
    error_description?: string;
  };
  if (typeof b.error === 'string')
    return new GoogleApiError(status, b.error, `${what}: ${b.error_description ?? b.error}`);
  const reason = b.error?.errors?.[0]?.reason ?? b.error?.status;
  return new GoogleApiError(
    status,
    reason,
    `${what}: ${b.error?.message ?? `Google answered ${status}`}`,
  );
}
