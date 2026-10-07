import { createHash } from 'node:crypto';
import type { Principal } from '@app/contracts';
import type { idempotencyRepo } from '@app/db';
import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { concatMap, from, type Observable, of, switchMap } from 'rxjs';
import { IDEMPOTENCY_REPO } from '../infra/db.module.js';
import { type ApiRequest, header } from './principal.js';

type IdempotencyRepo = ReturnType<typeof idempotencyRepo>;

/** Keys are per caller: the agent acting for Ana never shares a key with Ana herself. */
function principalId(p: Principal) {
  return [p.actor.kind, p.actor.id, p.actingFor?.userId ?? ''].join(':');
}

/**
 * Replays the stored response when a write repeats its idempotency-key.
 *
 * Simplification: two identical requests arriving at the same instant can both
 * miss the lookup. A production version claims the key first (insert against the
 * primary key), then does the work.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(IDEMPOTENCY_REPO) private readonly repo: IdempotencyRepo) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const key = header(req, 'idempotency-key');
    if (req.method === 'GET' || !key || !req.principal) return next.handle();

    const owner = principalId(req.principal);
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    return from(this.repo.find(key, owner)).pipe(
      switchMap((hit) => {
        if (hit) {
          if (hit.requestHash !== requestHash) {
            throw new ConflictException('idempotency-key was already used for a different request');
          }
          return of(hit.response);
        }
        // Save before responding, so a retry that arrives right after sees the key.
        return next.handle().pipe(
          concatMap(async (response) => {
            await this.repo.save({ key, principalId: owner, requestHash, response });
            return response;
          }),
        );
      }),
    );
  }
}
