// How the Microsoft calendar connector reaches Microsoft: one function per request, so a fake
// (tests, offline development) replaces the network without touching the client. Live requests
// go through the egress guard, and only to the fixed Microsoft hosts (decisions B21).
import { checkUrl, safeRequest } from '../egress.js';

/** One request to Microsoft (the identity platform or Graph). */
export interface MicrosoftRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON, or a form for the token endpoint. */
  body?: string;
}

/** Microsoft's answer: the status and the body, parsed when it is JSON. */
export interface MicrosoftResponse {
  status: number;
  body: unknown;
}

export type MicrosoftTransport = (req: MicrosoftRequest) => Promise<MicrosoftResponse>;

/** Where Microsoft is. Deployment settings may point them elsewhere (a proxy, a test double). */
export interface MicrosoftEndpoints {
  /** The identity platform, without a trailing slash: `<login>/<tenant>/oauth2/v2.0/…`. */
  login: string;
  /** Graph, with its version, without a trailing slash. */
  graph: string;
}

export const MICROSOFT_ENDPOINTS: MicrosoftEndpoints = {
  login: 'https://login.microsoftonline.com',
  graph: 'https://graph.microsoft.com/v1.0',
};

/** The hosts a set of endpoints names: the only ones the live transport calls. */
export const hostsOf = (e: MicrosoftEndpoints) => [
  ...new Set([new URL(e.login).hostname, new URL(e.graph).hostname]),
];

/**
 * Microsoft over the network, through the egress guard: https only, public addresses only, and
 * only the hosts given (the endpoints'). Anything else is refused before a socket opens.
 */
export function guardedTransport(options: {
  hosts: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}): MicrosoftTransport {
  const allowed = new Set(options.hosts.map((h) => h.toLowerCase()));
  return async (req) => {
    const checked = checkUrl(req.url);
    if (!checked.ok) throw new MicrosoftApiError(0, 'egress_blocked', checked.reason);
    if (!allowed.has(checked.url.hostname.toLowerCase()))
      throw new MicrosoftApiError(
        0,
        'egress_blocked',
        `${checked.url.hostname} is not a Microsoft host this server calls`,
      );
    const res = await safeRequest(
      req.url,
      { method: req.method, headers: req.headers ?? {}, ...(req.body ? { body: req.body } : {}) },
      {
        timeoutMs: options.timeoutMs ?? 15_000,
        maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
      },
    );
    if (res.truncated)
      throw new MicrosoftApiError(res.status, 'too_large', 'The answer was too large');
    const type = String(res.headers['content-type'] ?? '');
    let body: unknown = res.body;
    if (res.body && type.includes('json')) {
      try {
        body = JSON.parse(res.body);
      } catch {
        body = res.body;
      }
    }
    return { status: res.status, body: res.body ? body : null };
  };
}

/** A refusal or failure from Microsoft: its HTTP status and its code, when it gave one. */
export class MicrosoftApiError extends Error {
  override readonly name = 'MicrosoftApiError';
  constructor(
    readonly status: number,
    /** OAuth's `error` ('invalid_grant') or Graph's `error.code` ('ErrorItemNotFound'). */
    readonly code: string | undefined,
    message: string,
    /** The identity platform's AADSTS codes, read from its description. */
    readonly aadsts: readonly string[] = [],
  ) {
    super(message);
  }
}

/** The AADSTS codes a description names ('AADSTS65001: The user or administrator…'). */
export const aadstsOf = (text: unknown): string[] =>
  typeof text === 'string' ? [...new Set(text.match(/AADSTS\d{5,6}/g) ?? [])] : [];

/** The error Microsoft's body names: OAuth's { error, error_description } or Graph's { error }. */
export function microsoftError(status: number, body: unknown, what: string): MicrosoftApiError {
  const b = (body ?? {}) as {
    error?: string | { code?: string; message?: string };
    error_description?: string;
    error_codes?: number[];
  };
  if (typeof b.error === 'string') {
    const codes = [
      ...aadstsOf(b.error_description),
      ...(b.error_codes ?? []).map((c) => `AADSTS${c}`),
    ];
    return new MicrosoftApiError(
      status,
      b.error,
      `${what}: ${b.error_description?.split('\n')[0] ?? b.error}`,
      [...new Set(codes)],
    );
  }
  return new MicrosoftApiError(
    status,
    b.error?.code,
    `${what}: ${b.error?.message ?? `Microsoft answered ${status}`}`,
  );
}
