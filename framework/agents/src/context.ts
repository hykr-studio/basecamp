import { createHmac } from 'node:crypto';
import { createApiClient } from '@hykr/api-client';
import { AGENT_RUN_HEADER } from '@hykr/contracts';
import { AGENT_ID } from './version.js';

/**
 * The credential of one run of a business's agent (A6): an HMAC of its run id with the agent key,
 * so only the server's processes can make one, nothing stores it, and a resumed run makes the
 * same. The API's `agent-run` identity provider checks it and acts for the agent's owner.
 */
export function agentRunToken(runId: string, key = process.env.AGENT_API_KEY ?? ''): string {
  if (!key) throw new Error('AGENT_API_KEY is not set');
  return createHmac('sha256', key).update(`agent-run:${runId}`).digest('hex');
}

type ToolContext = {
  requestContext?: { get(key: string): unknown };
  tracingContext?: { currentSpan?: { traceId?: string } };
};

/**
 * An API client for one run, built from the tool's execution context. Each call carries
 * the agent's key, the person it acts for, and the run, so the API's guard and audit
 * trail see exactly who did what.
 *
 * The run id comes from the request context (the chat endpoint sets it to the trace id).
 * Without one, as in Studio, the trace id is used, so audit rows still point at the trace.
 */
export type ApiFor = (ctx?: ToolContext) => ReturnType<typeof createApiClient>;

/**
 * `apiFor` for one assistant: its version for this turn (the turn's model is part of it) goes on
 * every call, so audit rows name it.
 */
export const createApiFor =
  (version: (ctx?: ToolContext) => string): ApiFor =>
  (ctx) => {
    // Whom it acts for ("user:<id>" / "contact:<id>"), in which business; Studio and evals give
    // a bare user id, which the API also accepts.
    const actingFor =
      (ctx?.requestContext?.get('actingFor') as string | undefined) ??
      (ctx?.requestContext?.get('userId') as string | undefined);
    const tenantId = ctx?.requestContext?.get('tenantId') as string | undefined;
    const runId =
      (ctx?.requestContext?.get('runId') as string | undefined) ??
      ctx?.tracingContext?.currentSpan?.traceId;
    const channel = ctx?.requestContext?.get('channel') as string | undefined;
    if (!actingFor) {
      throw new Error(
        'Agent tools need a userId in the request context (in Studio: pick a preset)',
      );
    }
    if (!runId) throw new Error('Agent tools need a runId or a trace');
    // A run of one of the business's agents: its own token, never the assistant's key. The API
    // fixes whom it acts for, the business and the channel from the run itself.
    if (ctx?.requestContext?.get('agent'))
      return createApiClient({
        baseUrl: process.env.API_INTERNAL_URL ?? 'http://localhost:3000',
        headers: () => ({
          [AGENT_RUN_HEADER]: agentRunToken(runId),
          'x-run-id': runId,
          'x-acting-for': actingFor,
          ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
        }),
      });
    return createApiClient({
      baseUrl: process.env.API_INTERNAL_URL ?? 'http://localhost:3000',
      headers: () => ({
        'x-agent-key': process.env.AGENT_API_KEY ?? '',
        'x-agent-id': AGENT_ID,
        'x-acting-for': actingFor,
        ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
        'x-run-id': runId,
        'x-agent-version': version(ctx),
        // The turn's channel (app, voice, whatsapp), so every audit row says how it came in.
        ...(channel ? { 'x-channel': channel } : {}),
      }),
    });
  };
