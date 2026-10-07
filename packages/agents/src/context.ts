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
  const userId = ctx?.requestContext?.get('userId') as string | undefined;
  const runId =
    (ctx?.requestContext?.get('runId') as string | undefined) ??
    ctx?.tracingContext?.currentSpan?.traceId;
  if (!userId) {
    throw new Error('Agent tools need a userId in the request context (in Studio: pick a preset)');
  }
  if (!runId) throw new Error('Agent tools need a runId or a trace');
  return createApiClient({
    baseUrl: process.env.API_INTERNAL_URL ?? 'http://localhost:3000',
    headers: () => ({
      'x-agent-key': process.env.AGENT_API_KEY ?? '',
      'x-agent-id': AGENT_ID,
      'x-acting-for': userId,
      'x-run-id': runId,
      'x-agent-version': agentVersion(),
    }),
  });
}
