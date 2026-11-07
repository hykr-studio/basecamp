import {
  type AcceptedInvite,
  type AddGrantInput,
  type Approval,
  type BusinessRoles,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamRequest,
  type ClientSettings,
  type CommandSpec,
  type CreatedInvite,
  type CreateInviteInput,
  type CreditPurchase,
  type CreditsStatus,
  type DefineRoleInput,
  type DocumentChannel,
  type DocumentInfo,
  type DocumentKindInfo,
  type DocumentRecipient,
  type EditRoleInput,
  type EntitySpec,
  type FeatureState,
  type FileInfo,
  type FileTarget,
  type FileTranscript,
  type HandoffThread,
  type HistoryEntry,
  IMPORT_UPLOAD,
  type ImportOptionsInput,
  type Inbox,
  type Invite,
  type JobInfo,
  type LedgerEntry,
  type ListInput,
  type ListJobsQuery,
  type Me,
  type Member,
  type Page,
  type PresignFileInput,
  type PresignFileResult,
  type PublicBranding,
  type PushDevice,
  pathParams,
  type RecallQuery,
  type RecallResult,
  type RecordGrant,
  type RecordVersion,
  type RegisterPushToken,
  type RenderDocumentInput,
  RenderDocumentSpec,
  type RoleView,
  SendDocumentSpec,
  type SlaListInput,
  type SlaTimer,
  StartImportSpec,
  type Summary,
  type SummaryInput,
  type TemplateStatus,
  type TenantDomain,
  type Thread,
  type ThreadMessage,
  toQueryString,
  type UndoResult,
  type VoiceSessionEnd,
  type VoiceSessionRequest,
  type VoiceSessionResponse,
  type WriteResult,
} from '@hykr/contracts';
import type { z } from 'zod';
import { type LiveMessage, liveMessages, textOf } from './live.js';

export {
  type LiveMessage,
  liveMessages,
  readServerSentEvents,
  type ServerSentEvent,
  textOf,
} from './live.js';

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
  /** Counts and totals (GET /api/<plural>/summary): the list's filters, groupBy, sum, avg… */
  summary(query?: SummaryInput): Promise<Summary>;
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

  /**
   * The live stream (GET /api/live): `ready`, then one `change` per event about a record the
   * person may read. Resolves when the server closes it; rejects on a refusal or a network
   * error. Abort with `signal`.
   */
  async function live(onMessage: (m: LiveMessage) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${opts.baseUrl}/api/live`, {
      credentials: opts.credentials,
      headers: { accept: 'text/event-stream', ...(await opts.headers?.()) },
      signal,
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, parseBody(await res.text()));
    for await (const m of liveMessages(textOf(res.body))) onMessage(m);
  }

  /** An entity's summary by its plural ('orders'), for views that name it (kpi.row's `of`). */
  function summary(plural: string, query: SummaryInput = {}): Promise<Summary> {
    return call('GET', `/api/${encodeURIComponent(plural)}/summary${toQueryString(query)}`);
  }

  function entity<S extends EntitySpec>(spec: S): EntityClient<S> {
    const base = `/api/${spec.plural}`;
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
    return {
      list: (query) => call('GET', `${base}${toQueryString(query)}`),
      summary: (query) => summary(spec.plural, query),
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

  /** A URL the API gave relative to itself (a local store's), made absolute. */
  const absolute = (url: string) => (url.startsWith('/') ? `${opts.baseUrl}${url}` : url);
  const withUrl = (f: FileInfo): FileInfo => (f.url ? { ...f, url: absolute(f.url) } : f);
  const fileUrl = (id: string, rest = '') => `/api/files/${encodeURIComponent(id)}${rest}`;

  const files = {
    /** Step one of an upload: a pending file, and where to PUT its bytes. */
    presign: async (input: PresignFileInput) => {
      const out = await call<PresignFileResult>('POST', '/api/files', input);
      return { ...out, upload: { ...out.upload, url: absolute(out.upload.url) } };
    },
    /** Step three: the bytes are there. */
    confirm: async (id: string) => withUrl(await call<FileInfo>('POST', fileUrl(id, '/confirm'))),
    /** One file, with a short-lived download URL (none for the assistant). */
    get: async (id: string) => withUrl(await call<FileInfo>('GET', fileUrl(id))),
    /** The files of these ids the caller reaches; the others are left out. */
    getMany: async (ids: readonly string[]) => {
      if (!ids.length) return [] as FileInfo[];
      const out = await call<{ items: FileInfo[] }>(
        'GET',
        `/api/files?ids=${ids.map(encodeURIComponent).join(',')}`,
      );
      return out.items.map(withUrl);
    },
    /** Throw away an upload that is on no record yet. */
    remove: (id: string) => call<null>('DELETE', fileUrl(id)),
    /** An audio file's words (kept once heard). */
    transcribe: (id: string) => call<FileTranscript>('POST', fileUrl(id, '/transcribe')),
    /**
     * Presign, PUT the bytes, confirm: a ready file for one entity's file field, whose id the
     * record's create or update then carries.
     */
    upload: async (
      body: Blob | ArrayBuffer | Uint8Array,
      o: { name: string; mime: string; for: FileTarget },
    ): Promise<FileInfo> => {
      const size = body instanceof Blob ? body.size : body.byteLength;
      const { file, upload } = await files.presign({
        name: o.name,
        mime: o.mime,
        size,
        for: o.for,
      });
      const put = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: body as BodyInit,
        credentials: 'omit',
      });
      if (!put.ok) throw new ApiError(put.status, parseBody(await put.text()));
      return files.confirm(file.id);
    },
  };

  const jobUrl = (id: string, rest = '') => `/api/jobs/${encodeURIComponent(id)}${rest}`;
  const jobs = {
    /** One job: its status, progress, message, output and result files' ids. */
    get: (id: string) => call<JobInfo>('GET', jobUrl(id)),
    /** A record's jobs (`entity` and `id`), or else the caller's own; newest first. */
    list: async (q: ListJobsQuery = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
      const qs = params.toString();
      return (await call<{ items: JobInfo[] }>('GET', `/api/jobs${qs ? `?${qs}` : ''}`)).items;
    },
    /** Stop a job that has not finished (people only). */
    cancel: (id: string) => call<JobInfo>('POST', jobUrl(id, '/cancel')),
  };

  const imports = {
    /** Upload a file to import (CSV, JSON or NDJSON): a ready file whose id `start` takes. */
    upload: (body: Blob | ArrayBuffer | Uint8Array, o: { name: string; mime: string }) =>
      files.upload(body, { ...o, for: { ...IMPORT_UPLOAD } }),
    /**
     * Import one entity's records from an uploaded file, through the write path: a job
     * (`imports.records`) the worker runs, whose output is the counts and whose file is the error
     * report. People with `imports.run`; it may wait for an approval.
     */
    start: (options: ImportOptionsInput, key = newKey()) => command(StartImportSpec, options, key),
  };

  const documentUrl = (id: string) => `/api/documents/${encodeURIComponent(id)}`;
  const withDocumentUrl = (d: DocumentInfo): DocumentInfo =>
    d.url ? { ...d, url: absolute(d.url) } : d;

  const documents = {
    /** Make a new version of a record's document; it starts `pending` (made in the background). */
    render: (input: RenderDocumentInput, key = newKey()) => command(RenderDocumentSpec, input, key),
    /** Send a document by WhatsApp or email (the assistant's send to others waits for approval). */
    send: (documentId: string, to: DocumentRecipient, channel?: DocumentChannel, key = newKey()) =>
      command(SendDocumentSpec, { documentId, to, ...(channel ? { channel } : {}) }, key),
    /** One document, with its sends and, for people once it is made, a short-lived URL. */
    get: async (id: string) => withDocumentUrl(await call<DocumentInfo>('GET', documentUrl(id))),
    /** A record's documents the caller reaches, newest first. */
    list: async (entity: string, id: string) =>
      (
        await call<{ items: DocumentInfo[] }>(
          'GET',
          `/api/documents?entity=${encodeURIComponent(entity)}&id=${encodeURIComponent(id)}`,
        )
      ).items,
    /** The kinds of document an entity has (every kind without one). */
    kinds: async (entity?: string) =>
      (
        await call<{ items: DocumentKindInfo[] }>(
          'GET',
          `/api/documents/kinds${entity ? `?entity=${encodeURIComponent(entity)}` : ''}`,
        )
      ).items,
  };

  return {
    entity,
    summary,
    command,
    /** Files: uploads, and files reached through the records they are on. */
    files,
    /** Long-running jobs: a record's, or the caller's own. */
    jobs,
    /** Bulk import: a file of one entity's records, through the write path. */
    imports,
    /** Documents (PDFs) of records: make, read, send. */
    documents,
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
    /**
     * The business's people, roles and invitations (people only). Reading needs `members.read`,
     * changing anything `members.manage`.
     */
    members: {
      list: () => call<Member[]>('GET', '/api/members'),
      setRoles: (userId: string, roles: string[], key = newKey()) =>
        call<WriteResult<unknown>>(
          'PATCH',
          `/api/members/${encodeURIComponent(userId)}`,
          { roles },
          key,
        ),
      remove: (userId: string, key = newKey()) =>
        call<WriteResult<unknown>>(
          'DELETE',
          `/api/members/${encodeURIComponent(userId)}`,
          undefined,
          key,
        ),
      /** Every role the business has (declared, with its edits, and its own), and every capability. */
      roles: () => call<BusinessRoles>('GET', '/api/members/roles'),
      defineRole: (input: DefineRoleInput, key = newKey()) =>
        call<WriteResult<RoleView>>('POST', '/api/members/roles', input, key),
      /** `null` puts a declared role's label or capabilities back as the application has them. */
      editRole: (name: string, input: EditRoleInput, key = newKey()) =>
        call<WriteResult<RoleView>>(
          'PATCH',
          `/api/members/roles/${encodeURIComponent(name)}`,
          input,
          key,
        ),
      removeRole: (name: string, key = newKey()) =>
        call<WriteResult<unknown>>(
          'DELETE',
          `/api/members/roles/${encodeURIComponent(name)}`,
          undefined,
          key,
        ),
      invites: () => call<Invite[]>('GET', '/api/members/invites'),
      /** The answer carries the link's token, this once. */
      invite: (input: CreateInviteInput) =>
        call<WriteResult<CreatedInvite>>('POST', '/api/members/invites', input),
      revokeInvite: (id: string, key = newKey()) =>
        call<WriteResult<Invite>>(
          'DELETE',
          `/api/members/invites/${encodeURIComponent(id)}`,
          undefined,
          key,
        ),
      /** Join the business an invitation is for, signed in with the email it was sent to. */
      acceptInvite: (token: string, key = newKey()) =>
        call<WriteResult<AcceptedInvite>>('POST', '/api/members/invites/accept', { token }, key),
    },
    /** Who reaches one record by a grant (`records.grant`), and giving or taking it. */
    grants: {
      list: (resourceType: string, resourceId: string) =>
        call<RecordGrant[]>(
          'GET',
          `/api/grants?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`,
        ),
      add: (input: AddGrantInput, key = newKey()) =>
        call<WriteResult<RecordGrant>>('POST', '/api/grants', input, key),
      remove: (id: string, key = newKey()) =>
        call<WriteResult<unknown>>(
          'DELETE',
          `/api/grants/${encodeURIComponent(id)}`,
          undefined,
          key,
        ),
    },
    /**
     * The business's setup (A11). Changes go through `command(SetFeatureSpec | UpdateBrandingSpec
     * | UpdateWordingSpec | AddDomainSpec | VerifyDomainSpec | RemoveDomainSpec, input)`, custom
     * fields through `entity(CustomFieldSpec)`.
     */
    settings: {
      /** Flags on, what is off, branding and the business's phrases: what the apps need. */
      get: () => call<ClientSettings>('GET', '/api/settings'),
      /** Every declared flag, on or off here, and who switches it. */
      features: () => call<FeatureState[]>('GET', '/api/features'),
      /** The business's web addresses (settings managers only). */
      domains: () => call<TenantDomain[]>('GET', '/api/settings/domains'),
      /**
       * Branding on a verified custom domain, before signing in: of `origin` (a web page passes
       * its own, `window.location.origin`), else of the request's Origin. 404 anywhere else.
       */
      publicBranding: (origin?: string) =>
        call<PublicBranding>(
          'GET',
          origin
            ? `/api/branding/public?origin=${encodeURIComponent(origin)}`
            : '/api/branding/public',
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
    /**
     * Move a record along its state machine (POST /api/transitions): done with the record, or
     * needs_approval when the transition waits. `input`: the transition's own fields.
     */
    transition: <S extends EntitySpec>(
      spec: S,
      id: string,
      name: string,
      input: Partial<z.input<S['schemas']['update']>> = {},
      key = newKey(),
    ): Promise<WriteResult<z.infer<S['schemas']['read']>>> =>
      call(
        'POST',
        `/api/transitions/${spec.plural}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
        input,
        key,
      ),
    /** SLA clocks: a record's (by its entity's plural), or the business's in one status. */
    sla: {
      of: (plural: string, id: string) =>
        call<SlaTimer[]>('GET', `/api/sla/${plural}/${encodeURIComponent(id)}`),
      list: (q: SlaListInput = {}) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
        const qs = params.toString();
        return call<SlaTimer[]>('GET', `/api/sla${qs ? `?${qs}` : ''}`);
      },
    },
    /** The revisions of a versioned record's series, oldest first (people only). */
    versions: (resourceType: string, resourceId: string) =>
      call<RecordVersion[]>(
        'GET',
        `/api/history/versions?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`,
      ),
    /** A record's history from the audit trail (people only). */
    /** `resourceType`: any entity name in the catalog (see entityNames). */
    history: (resourceType: string, resourceId: string) =>
      call<HistoryEntry[]>(
        'GET',
        `/api/history?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`,
      ),
    /** The latest 20 lines across every record, newest first: since a moment, by one actor. */
    recentHistory: (q: { since?: string; actor?: 'assistant' | 'you' } = {}) => {
      const params = new URLSearchParams();
      if (q.since) params.set('since', q.since);
      if (q.actor) params.set('actor', q.actor);
      const qs = params.toString();
      return call<HistoryEntry[]>('GET', `/api/history${qs ? `?${qs}` : ''}`);
    },
    decideApproval: (id: string, approve: boolean) =>
      call<Approval>(
        'POST',
        `/api/approvals/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`,
      ),
    /**
     * Undo a write within its undo window: the `undo.id` its result carried (people only, the
     * person it was for). 409 when it changed since or was undone already; 403 once the window
     * closed.
     */
    undo: (id: string) => call<UndoResult>('POST', `/api/undo/${encodeURIComponent(id)}`),
    chat: (input: ChatRequest) => call<ChatResponse>('POST', '/api/chat/once', input),
    chatStream,
    live,
    /** This device, for push (people only); forget needs no session. */
    push: {
      register: (input: RegisterPushToken) => call<PushDevice>('POST', '/api/push/tokens', input),
      devices: () => call<PushDevice[]>('GET', '/api/push/tokens'),
      forget: (token: string) => call<null>('POST', '/api/push/tokens/forget', { token }),
    },
    /** Voice: a person starts a session; the voice worker reports its end. */
    voice: {
      session: (input: Partial<VoiceSessionRequest> = {}) =>
        call<VoiceSessionResponse>('POST', '/api/voice/session', input),
      end: (input: VoiceSessionEnd) => call<null>('POST', '/api/voice/end', input),
    },
    /** The business's credits (people only): status for its team, the rest for its managers. */
    credits: {
      status: () => call<CreditsStatus>('GET', '/api/credits'),
      ledger: (before?: string) =>
        call<{ items: LedgerEntry[]; next: string | null }>(
          'GET',
          `/api/credits/ledger${before ? `?before=${encodeURIComponent(before)}` : ''}`,
        ),
      /** Buy credits: the answer carries the checkout, or waits for an approval. */
      buy: (amount: number, provider?: string, key = newKey()) =>
        call<WriteResult<CreditPurchase>>(
          'POST',
          '/api/credits/purchases',
          { amount, ...(provider ? { provider } : {}) },
          key,
        ),
      purchase: (id: string) =>
        call<CreditPurchase>('GET', `/api/credits/purchases/${encodeURIComponent(id)}`),
      /** The business's own alert threshold, in per cent. */
      setAlertAt: (alertAt: number, key = newKey()) =>
        call<WriteResult<{ alertAt: number }>>('PUT', '/api/credits/alerts', { alertAt }, key),
    },
    /** What is remembered, by meaning: memories the caller may read now, best first. */
    memory: {
      recall: (q: RecallQuery) => {
        const params = new URLSearchParams({ q: q.q });
        if (q.about) params.set('about', q.about);
        if (q.limit) params.set('limit', String(q.limit));
        if (q.kinds) params.set('kinds', q.kinds);
        return call<RecallResult>('GET', `/api/memory/recall?${params}`);
      },
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

export { type ReadToolResult, runReadTool } from './read-tools.js';
