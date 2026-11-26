import type { ReadToolDef } from '@hykr/contracts';
import { type ApiClient, ApiError } from './index.js';

/**
 * What a read tool answers, as data the model can explain: the API's answer, the API's refusal
 * (404 for a record that is not the caller's, 403 for an action that is not theirs), or an
 * input that was never sent because it is not valid. The assistant's tools answer the same way.
 */
export type ReadToolResult =
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: unknown }
  | { ok: false; error: 'invalid_input'; issues: unknown[] };

/**
 * Run one read tool (`entityReadTools` in @hykr/contracts) through `client`, so with whatever
 * credentials the client sends: the person's session, an agent's key. The input is checked
 * before anything is sent. A list asks for the tool's row cap unless the input asks for fewer.
 * Anything but an API refusal (the network, a bug) is thrown.
 */
export async function runReadTool(
  client: Pick<ApiClient, 'entity'>,
  tool: ReadToolDef,
  input: unknown,
): Promise<ReadToolResult> {
  const parsed = tool.input.safeParse(input ?? {});
  if (!parsed.success)
    return { ok: false, error: 'invalid_input', issues: parsed.error.issues as unknown[] };
  const api = client.entity(tool.spec);
  try {
    const value = parsed.data as Record<string, unknown>;
    const result =
      tool.action === 'list'
        ? await api.list({ ...(tool.maxLimit ? { limit: tool.maxLimit } : {}), ...value })
        : await api.get(String(value.id));
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, error: e.body };
    throw e;
  }
}
