import { createHash, timingSafeEqual } from 'node:crypto';
import { type AgentIdentity, identityProviders } from '@hykr/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { config } from '../config.js';

let storage: ThrottlerStorageRedisService | undefined;

/**
 * The throttle's counters, in Redis, shared by every API process: the API's routes and Better
 * Auth's (infra/auth.ts). One connection, closed with the app.
 */
export const throttleStorage = () => {
  storage ??= new ThrottlerStorageRedisService(config.redisUrl);
  return storage;
};

/**
 * Better Auth's own limits (3 sign-ins, sign-ups, password or email changes per 10 seconds per
 * address; 100 calls elsewhere), counted with the throttle's: in production and whenever
 * THROTTLE=on, never with THROTTLE=off. Read on every request, as the API's throttle is (the e2e
 * suite switches it). Development leaves them off, as Better Auth does: an eval signs up a person
 * per module in a few seconds.
 */
export const authRateLimit = () => ({
  enabled: true,
  customRules: {
    '/**': (_request: unknown, rule: { window: number; max: number }) =>
      process.env.THROTTLE === 'off' ||
      (process.env.THROTTLE !== 'on' && process.env.NODE_ENV !== 'production')
        ? (false as const)
        : rule,
  },
  customStorage: {
    async consume(key: string, rule: { window: number; max: number }) {
      const redis = throttleStorage().redis;
      const at = `${config.queuePrefix}:auth-rate:${key}`;
      const [[, hits], [, ttl]] = (await redis.multi().incr(at).pttl(at).exec()) as [
        [unknown, number],
        [unknown, number],
      ];
      if (ttl < 0) await redis.pexpire(at, rule.window * 1000);
      const allowed = hits <= rule.max;
      return {
        allowed,
        retryAfter: allowed ? null : Math.ceil((ttl < 0 ? rule.window * 1000 : ttl) / 1000),
      };
    },
  },
});

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
