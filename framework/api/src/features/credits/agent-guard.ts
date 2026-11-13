// A business paused at 100% stops its agents mid-run (H3): every call an agent makes to the API
// (the assistant's tools with its key, an agent run's token, an MCP client's token) is refused
// with 402 while the business is paused, so a turn or a run that crosses the cap in the middle
// makes no more calls. The assistant then ends the run with the paused sentence (`EndWhenPaused`
// in @hykr/agents). A relay (the voice worker) is not stopped here: its turns pass the turn hook,
// and its session reports must still be metered.
import type { UsageRefusal } from '@hykr/contracts';
import type { ApiRequest } from '@hykr/core';
import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { from, type Observable, switchMap } from 'rxjs';
import { TURN_METERS } from './budget.js';
import { creditsService } from './credits.service.js';
import { FrameworkMeters } from './meters.js';

/** The body a paused business's agent gets: the same as a refused voice session's. */
export const creditsPaused = (refusal: UsageRefusal) =>
  new HttpException({ error: 'credits_paused', rule: refusal.rule, reason: refusal.reason }, 402);

/**
 * The meters an agent's call spends: what a turn spends (the model tokens its run spends around
 * it, and its tool call). An MCP client runs its own model, so only its tool calls are ours.
 */
const metersFor = (channel: string | undefined) =>
  channel === 'mcp'
    ? [{ meter: FrameworkMeters.toolCalls.name }]
    : TURN_METERS.map((m) => ({ meter: m.name }));

@Injectable()
export class CreditsAgentInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const p = req.principal;
    const svc = creditsService();
    if (!svc || !p?.tenantId || p.actor.kind !== 'agent' || !req.agent || req.agent.relay)
      return next.handle();
    const tenantId = p.tenantId;
    return from(svc.checkMany(tenantId, metersFor(p.channel))).pipe(
      switchMap((refusals) => {
        // Settings that do not parse refuse too (fail closed).
        const refused = refusals.find((r) => r !== null);
        if (refused) throw creditsPaused(refused);
        return next.handle();
      }),
    );
  }
}
