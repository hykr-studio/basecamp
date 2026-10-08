import {
  type Approval,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamRequest,
  type CommandSpec,
  type EntitySpec,
  type HandoffThread,
  type HistoryEntry,
  type Inbox,
  type ListInput,
  type Me,
  type Page,
  pathParams,
  type TemplateStatus,
  type Thread,
  type ThreadMessage,
  toQueryString,
  type VoiceSessionEnd,
  type VoiceSessionRequest,
  type VoiceSessionResponse,
  type WriteResult,
} from '@app/contracts';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  /**
   * Extra headers per request. The agent passes its key, the person it acts for, and the run;
   * the native app passes the session cookie it keeps in SecureStore (read asynchronously).
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** The web app passes 'include' so the browser sends the session cookie itself. */
  credentials?: 'include' | 'omit';
};

/**
 * One chunk of the AI SDK UI message stream /api/chat answers with: text deltas, tool calls
 * and their outputs, and the message's metadata (run and thread). Loosely typed: a reader
 * picks the chunk types it needs and ignores the rest.
 */
export type ChatChunk = { type: string } & Record<string, unknown>;

/** A response body: JSON, or the raw text (a proxy's HTML error page), or null when empty. */
function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * One server-sent event: its `data:` lines joined, parsed as a chunk. Comments, `[DONE]` and
 * a line that is not JSON are skipped, never the end of the turn.
 */
function eventOf(event: string): ChatChunk | undefined {
  const data = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return undefined;
  try {
    return JSON.parse(data) as ChatChunk;
  } catch {
    return undefined;
  }
}

/** Every write gets a fresh idempotency key by default. A caller that retries passes the same key. */
const newKey = () => crypto.randomUUID();

/** Typed methods for one entity, from its spec: the Expo app and the agent's tools use these. */
export type EntityClient<S extends EntitySpec> = {
  list(query?: ListInput): Promise<Page<z.infer<S['schemas']['read']>>>;
  get(id: string): Promise<z.infer<S['schemas']['read']>>;
  create(
    input: z.input<S['schemas']['create']>,
    key?: string,
  ): Promise<WriteResult<z.infer<S['schemas']['read']>>>;
  update(
    id: string,
    patch: z.input<S['schemas']['update']>,
    key?: string,
  ): Promise<WriteResult<z.infer<S['schemas']['read']>>>;
  remove(id: string, key?: string): Promise<WriteResult<null>>;
};

export function createApiClient(opts: ApiClientOptions) {
  async function call<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      method,
      credentials: opts.credentials,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(await opts.headers?.()),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = parseBody(await res.text());
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  /** A streamed turn: the response's server-sent events, one parsed chunk at a time. */
  async function* chatStream(
    input: ChatStreamRequest,
    extra: Record<string, string> = {},
    signal?: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: 'POST',
      credentials: opts.credentials,
      headers: { 'content-type': 'application/json', ...(await opts.headers?.()), ...extra },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, parseBody(await res.text()));
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n?/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const chunk = eventOf(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (chunk) yield chunk;
        end = buffer.indexOf('\n\n');
      }
    }
    // A last event without its blank line still counts.
    const last = eventOf(buffer + decoder.decode().replace(/\r\n?/g, '\n'));
    if (last) yield last;
  }

  function entity<S extends EntitySpec>(spec: S): EntityClient<S> {
    const base = `/api/${spec.plural}`;
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
    return {
      list: (query) => call('GET', `${base}${toQueryString(query)}`),
      get: (id) => call('GET', one(id)),
      create: (input, key = newKey()) => call('POST', base, input, key),
      update: (id, patch, key = newKey()) => call('PATCH', one(id), patch, key),
      remove: (id, key = newKey()) => call('DELETE', one(id), undefined, key),
    };
  }

  /** Path params (:meetingId) come out of the input; the rest is the body. */
  function command<S extends CommandSpec>(
    spec: S,
    input: z.input<S['input']>,
    key = newKey(),
  ): Promise<WriteResult<z.infer<S['output']>>> {
    const values = { ...(input as Record<string, unknown>) };
    let path = spec.http.path;
    for (const name of pathParams(path)) {
      path = path.replace(`:${name}`, encodeURIComponent(String(values[name])));
      delete values[name];
    }
    return call(spec.http.method, path, values, key);
  }

  return {
    entity,
    command,
    /** Who is signed in, in which business, with which roles. */
    me: () => call<Me>('GET', '/api/me'),
    /** The back office: conversations staff have taken from the assistant (staff only). */
    backoffice: {
      inbox: () => call<Inbox>('GET', '/api/backoffice/inbox'),
      handoff: (id: string) =>
        call<HandoffThread>('GET', `/api/backoffice/handoffs/${encodeURIComponent(id)}`),
      take: (id: string) =>
        call<unknown>('POST', `/api/backoffice/handoffs/${encodeURIComponent(id)}/take`),
      /** As text inside the 24-hour window; as the reply template outside it. */
      reply: (id: string, text: string) =>
        call<{ sent: 'text' | 'template' }>(
          'POST',
          `/api/backoffice/handoffs/${encodeURIComponent(id)}/reply`,
          { text },
        ),
      /** The assistant's suggested reply, to edit before sending. */
      draft: (id: string) =>
        call<{ text: string }>('POST', `/api/backoffice/handoffs/${encodeURIComponent(id)}/draft`),
      /** Back to the assistant, with what was resolved. */
      giveBack: (id: string, resolution?: string) =>
        call<{ state: string }>(
          'POST',
          `/api/backoffice/handoffs/${encodeURIComponent(id)}/return`,
          resolution ? { resolution } : {},
        ),
      templates: () => call<TemplateStatus[]>('GET', '/api/backoffice/templates'),
      consent: (
        contactId: string,
        input: { topic: 'service' | 'reminders' | 'marketing'; granted: boolean; note?: string },
      ) =>
        call<unknown>(
          'POST',
          `/api/backoffice/contacts/${encodeURIComponent(contactId)}/consent`,
          input,
        ),
    },
    /** People only: the agent gets 403. */
    listApprovals: () => call<Approval[]>('GET', '/api/approvals'),
    getApproval: (id: string) => call<Approval>('GET', `/api/approvals/${encodeURIComponent(id)}`),
    /** The person's WhatsApp number, so the assistant answers it (people only). */
    whatsapp: {
      get: () =>
        call<{ address: string; timeZone: string } | null>('GET', '/api/channels/whatsapp'),
      /** A one-time code to the number (WhatsApp's login_code_v1): proof the person holds it. */
      sendCode: (phone: string, timeZone: string, lang: 'en' | 'hi' | 'te' = 'en') =>
        call<{ sentTo: string; expiresInSeconds: number }>('POST', '/api/channels/whatsapp/code', {
          phone,
          timeZone,
          lang,
        }),
      /** The code they received: the number is linked to their account. */
      verify: (phone: string, code: string) =>
        call<{ address: string; timeZone: string }>('POST', '/api/channels/whatsapp/verify', {
          phone,
          code,
        }),
      unlink: () => call<void>('DELETE', '/api/channels/whatsapp'),
    },
    /** A record's history from the audit trail (people only). */
    /** `resourceType`: any entity name in the catalog (see entityNames). */
    history: (resourceType: string, resourceId: string) =>
      call<HistoryEntry[]>(
        'GET',
        `/api/history?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`,
      ),
    decideApproval: (id: string, approve: boolean) =>
      call<Approval>(
        'POST',
        `/api/approvals/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`,
      ),
    chat: (input: ChatRequest) => call<ChatResponse>('POST', '/api/chat/once', input),
    chatStream,
    /** Voice: a person starts a session; the voice worker reports its end. */
    voice: {
      session: (input: Partial<VoiceSessionRequest> = {}) =>
        call<VoiceSessionResponse>('POST', '/api/voice/session', input),
      end: (input: VoiceSessionEnd) => call<null>('POST', '/api/voice/end', input),
    },
    /** The person's conversations, kept on the server so every channel shares them (people only). */
    threads: {
      /** The latest thread, or a new one. */
      current: () => call<Thread>('GET', '/api/threads/current'),
      /** Start again: the new thread becomes the current one. */
      create: () => call<Thread>('POST', '/api/threads'),
      /** As UI messages: text, and each reply's tool parts with what they showed. */
      messages: (id: string) =>
        call<ThreadMessage[]>('GET', `/api/threads/${encodeURIComponent(id)}/messages`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
