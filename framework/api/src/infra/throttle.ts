import { createHash, timingSafeEqual } from 'node:crypto';
import { type AgentIdentity, identityProviders } from '@hykr/core';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { config } from '../config.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const keys = () => [config.agentApiKey, config.voiceAgentKey].filter(Boolean).map(sha256);

/** One agent, for whom it acts, in the business its credential fixes (when it fixes one). */
function trackerOf(identity: AgentIdentity): string | undefined {
  const { userId, contactId } = identity.actingFor ?? {};
  if (!identity.agentId || !userId === !contactId) return undefined;
  const subject = userId ? `user:${userId}` : `contact:${contactId}`;
  return `agent:${identity.agentId}:${subject}${identity.tenantId ? `@${identity.tenantId}` : ''}`;
}

/**
 * Limits per caller, not per address. The assistant's tool calls, every voice turn and every MCP
 * client's tool calls come from one process (one IP), so counting by IP would put every person's
 * calls, in every business, in one bucket.
 * - A request with a valid agent key counts against that agent and the person it acts for; a
 *   wrong key gets no bucket of its own (it falls back to the IP, and fails auth anyway).
 * - A credential a contributed identity provider recognises (an MCP client's token) counts
 *   against that agent, the person it acts for and the business the credential fixes. One the
 *   provider refuses gets no bucket of its own either.
 */
@Injectable()
export class CallerThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const key = req.headers['x-agent-key'];
    const actingFor = req.headers['x-acting-for'];
    if (typeof key === 'string') {
      const presented = sha256(key);
      if (typeof actingFor === 'string' && keys().some((k) => timingSafeEqual(k, presented)))
        return `agent:${req.headers['x-agent-id']}:${actingFor}`;
      // An agent key is never taken for another credential (as in PrincipalGuard).
      return req.ip ?? 'unknown';
    }
    // The providers in PrincipalGuard's order: the first that claims the credential decides.
    for (const provider of identityProviders.all()) {
      const identity = await provider
        .identify({ method: req.method, path: req.path, headers: req.headers })
        .catch(() => undefined);
      if (identity === null) continue;
      const tracker = identity && trackerOf(identity);
      if (tracker) return tracker;
      break;
    }
    return req.ip ?? 'unknown';
  }
}
