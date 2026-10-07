import {
  type Approval,
  type ChatRequest,
  type ChatResponse,
  type CommandSpec,
  type EntitySpec,
  type ListInput,
  type Page,
  pathParams,
  toQueryString,
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
  /** Extra headers per request. The agent passes its key, the person it acts for, and the run. */
  headers?: () => Record<string, string>;
  /** The web app passes 'include' so the session cookie goes along. */
  credentials?: 'include' | 'omit';
};

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
        ...opts.headers?.(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
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
    /** People only: the agent gets 403. */
    listApprovals: () => call<Approval[]>('GET', '/api/approvals'),
    decideApproval: (id: string, approve: boolean) =>
      call<Approval>(
        'POST',
        `/api/approvals/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`,
      ),
    chat: (input: ChatRequest) => call<ChatResponse>('POST', '/api/chat', input),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
