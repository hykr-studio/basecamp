// Share links (docs/decisions/B9.md): the team's links (`api.shares`, through the client's own
// session) and a guest's calls through one link (`createShareClient`: no session at all, the
// link's token in the path and, for a gated link, the session its code opened).
import {
  type AcceptanceInfo,
  type AcceptanceStatus,
  type CreateShareInput,
  type DocumentInfo,
  type Lang,
  SHARE_SESSION_HEADER,
  type ShareCodeSent,
  type ShareCreated,
  type Shared,
  type ShareKinds,
  type ShareLinkInfo,
  type ShareSession,
  type ShareSubmitInput,
  type ShareSubmitted,
  type ShareTarget,
  type WriteResult,
} from '@hykr/contracts';

type Call = <T>(method: string, path: string, body?: unknown, key?: string) => Promise<T>;

const q = encodeURIComponent;

/** The query naming what a link opens. */
const targetQuery = (t: ShareTarget) =>
  'form' in t
    ? `form=${q(t.form)}`
    : 'page' in t
      ? `page=${q(t.page)}`
      : `entity=${q(t.entity)}&id=${q(t.id)}`;

/** The team's links: what may be shared, a target's links, making and revoking one. */
export function sharesMethods(call: Call, newKey: () => string) {
  return {
    /** The shareable entities and public forms the application declares. */
    kinds: () => call<ShareKinds>('GET', '/api/shares/kinds'),
    /** A record's, a page's or a form's links, newest first (never their tokens). */
    list: async (target: ShareTarget) =>
      (await call<{ items: ShareLinkInfo[] }>('GET', `/api/shares?${targetQuery(target)}`)).items,
    /** A new link: its token and URL are in this answer only. */
    create: (input: CreateShareInput) =>
      call<WriteResult<ShareCreated>>('POST', '/api/shares', input),
    revoke: (id: string, key = newKey()) =>
      call<WriteResult<ShareLinkInfo>>('POST', `/api/shares/${q(id)}/revoke`, {}, key),
  };
}

export class ShareError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export type ShareClientOptions = {
  baseUrl: string;
  /** The link's token: the last part of `/share/<token>`. */
  token: string;
  /** The session a right code opened, for a gated link (read on every call). */
  session?: () => string | null | undefined;
};

/**
 * A guest's calls through one share link. It sends no cookie and no credentials of the app's:
 * the link is the only credential, and the server answers as its guest.
 */
export function createShareClient(opts: ShareClientOptions) {
  const base = `/api/share/${q(opts.token)}`;
  const newKey = () => crypto.randomUUID();
  async function call<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
    const session = opts.session?.();
    const res = await fetch(`${opts.baseUrl}${base}${path}`, {
      method,
      credentials: 'omit',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(session ? { [SHARE_SESSION_HEADER]: session } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new ShareError(res.status, json);
    return json as T;
  }
  return {
    /** What the link shows: its gate until its code, then its record, page or form. */
    get: () => call<Shared>('GET', ''),
    /** Send the link's code to its recipient. */
    code: (lang?: Lang) =>
      call<WriteResult<ShareCodeSent>>('POST', '/code', lang ? { lang } : {}, newKey()),
    /** The code received: a session to keep for this link (send it back as `session`). */
    verify: (challengeId: string, code: string) =>
      call<WriteResult<ShareSession>>('POST', '/verify', { challengeId, code }),
    /** One of the record's PDFs, with a short-lived download URL. */
    document: (documentId: string) => call<DocumentInfo>('GET', `/documents/${q(documentId)}`),
    /** The acceptance of one of its PDFs, as the guest may go through it. */
    acceptance: {
      status: (documentId: string, lang?: string) =>
        call<AcceptanceStatus>(
          'GET',
          `/acceptances/documents/${q(documentId)}${lang ? `?lang=${q(lang)}` : ''}`,
        ),
      challenge: (input: { documentId: string; channel?: 'whatsapp' | 'email'; lang?: Lang }) =>
        call<WriteResult<{ id: string; sentTo: string; channel: string }>>(
          'POST',
          '/acceptances/challenges',
          input,
          newKey(),
        ),
      accept: (input: { challengeId: string; code: string }) =>
        call<WriteResult<AcceptanceInfo>>('POST', '/acceptances', input, newKey()),
    },
    /** A form link's answer: the new record's id. */
    submit: (input: ShareSubmitInput, key = newKey()) =>
      call<WriteResult<ShareSubmitted>>('POST', '/submit', input, key),
  };
}

export type ShareClient = ReturnType<typeof createShareClient>;
