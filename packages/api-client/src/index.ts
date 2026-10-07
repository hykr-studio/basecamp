import type {
  Approval,
  ChatRequest,
  ChatResponse,
  CreateTodoInput,
  Todo,
  UpdateTodoInput,
  WriteResult,
} from '@app/contracts';

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

  const todo = (id: string) => `/api/todos/${encodeURIComponent(id)}`;
  const approval = (id: string) => `/api/approvals/${encodeURIComponent(id)}`;

  return {
    listTodos: () => call<Todo[]>('GET', '/api/todos'),
    createTodo: (input: CreateTodoInput, key = newKey()) =>
      call<WriteResult>('POST', '/api/todos', input, key),
    updateTodo: (id: string, input: UpdateTodoInput, key = newKey()) =>
      call<WriteResult>('PATCH', todo(id), input, key),
    /** The agent gets { status: 'needs_approval' } back: the person has to approve. */
    deleteTodo: (id: string, key = newKey()) =>
      call<WriteResult>('DELETE', todo(id), undefined, key),

    /** People only: the agent gets 403. */
    listApprovals: () => call<Approval[]>('GET', '/api/approvals'),
    decideApproval: (id: string, approve: boolean) =>
      call<Approval>('POST', `${approval(id)}/${approve ? 'approve' : 'reject'}`),

    chat: (input: ChatRequest) => call<ChatResponse>('POST', '/api/chat', input),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
