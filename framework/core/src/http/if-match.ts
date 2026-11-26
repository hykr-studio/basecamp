// `If-Match` on HTTP writes (B12). Only an entity's update and delete check it (against the record
// version, B4); a request that sends one anywhere else is refused, so a precondition the server
// cannot check is never silently ignored. docs/decisions/B12.md.
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

const HONORS_IF_MATCH = 'core:honors-if-match';

/** This route checks the request's `If-Match` itself (the generated entity update and delete). */
export const HonorsIfMatch = () => SetMetadata(HONORS_IF_MATCH, true);

/**
 * On every route: a request with `If-Match` reaches only a route that checks it; anywhere else it
 * is 400 `if_match_unsupported`. Install it once (`APP_INTERCEPTOR`); the offline feature does.
 */
@Injectable()
export class IfMatchInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const sent = req.headers['if-match'];
    if (sent === undefined || sent === '') return next.handle();
    const honors = this.reflector.getAllAndOverride<boolean>(HONORS_IF_MATCH, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!honors)
      throw new BadRequestException({
        error: 'if_match_unsupported',
        reason: 'This route takes no If-Match: only a record update or delete checks one',
      });
    return next.handle();
  }
}
