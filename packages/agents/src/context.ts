import { createApiClient } from '@app/api-client';
import { AGENT_ID, agentVersion } from './version.js';

/**
 * An API client for one run, built from Mastra's request context. Each call carries
 * the agent's key, the person it acts for, and the run, so the API's guard and audit
 * trail see exactly who did what.
 */
export function apiFor(ctx?: { get(key: string): unknown }) {
  const userId = ctx?.get('userId') as string | undefined;
  const runId = ctx?.get('runId') as string | undefined;
  if (!userId || !runId) throw new Error('Agent tools need userId and runId');
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
