import { createApiClient } from '@app/api-client';
import { AGENT_ID, agentVersion } from './version.js';

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
export function apiFor(ctx?: ToolContext) {
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
    throw new Error('Agent tools need a userId in the request context (in Studio: pick a preset)');
  }
  if (!runId) throw new Error('Agent tools need a runId or a trace');
  return createApiClient({
    baseUrl: process.env.API_INTERNAL_URL ?? 'http://localhost:3000',
    headers: () => ({
      'x-agent-key': process.env.AGENT_API_KEY ?? '',
      'x-agent-id': AGENT_ID,
      'x-acting-for': actingFor,
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      'x-run-id': runId,
      'x-agent-version': agentVersion(),
      // The turn's channel (app, voice, whatsapp), so every audit row says how it came in.
      ...(channel ? { 'x-channel': channel } : {}),
    }),
  });
}
