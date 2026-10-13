import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { config } from '../config.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const keys = () => [config.agentApiKey, config.voiceAgentKey].filter(Boolean).map(sha256);

/**
 * Limits per caller, not per address. The assistant's tool calls and every voice turn come
 * from one process (one IP), so counting by IP would put every person's turns in one bucket.
 * A request with a valid agent key counts against that agent and the person it acts for; a
 * wrong key gets no bucket of its own (it falls back to the IP, and fails auth anyway).
 */
@Injectable()
export class CallerThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const key = req.headers['x-agent-key'];
    const actingFor = req.headers['x-acting-for'];
    if (typeof key === 'string' && typeof actingFor === 'string') {
      const presented = sha256(key);
      if (keys().some((k) => timingSafeEqual(k, presented)))
        return `agent:${req.headers['x-agent-id']}:${actingFor}`;
    }
    return req.ip ?? 'unknown';
  }
}
