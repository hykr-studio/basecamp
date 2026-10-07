import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@app/contracts';
import { type Database, userExists } from '@app/db';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { DB } from '../infra/db.module.js';

/** The only agent this API knows. Its key is AGENT_API_KEY. */
export const AGENT_ID = 'todo-agent';

export type ApiRequest = Request & {
  /** Set by Better Auth's guard when the request carries a valid session. */
  session?: { user: { id: string } } | null;
  principal?: Principal;
  requestId?: string;
};

export type RequestMeta = { requestId: string; idempotencyKey?: string };

export const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Hash both sides first: equal lengths for timingSafeEqual, and nothing leaks the key's length. */
function agentKeyMatches(presented: string) {
  return timingSafeEqual(sha256(presented), sha256(config.agentApiKey));
}

/**
 * Turns every request into exactly one principal before the handler runs:
 * a signed-in person, or the agent acting for one. Anything else is a 401.
 *
 * Pair it with @OptionalAuth() so Better Auth attaches a session when there is one.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<Response>();

    req.requestId = header(req, 'x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', req.requestId);

    const agentKey = header(req, 'x-agent-key');
    req.principal = agentKey ? await this.agentPrincipal(req, agentKey) : this.userPrincipal(req);
    return true;
  }

  private async agentPrincipal(req: ApiRequest, agentKey: string): Promise<Principal> {
    // A presented key that is wrong never falls back to the session.
    if (!agentKeyMatches(agentKey)) throw new UnauthorizedException('invalid agent key');
    if (header(req, 'x-agent-id') !== AGENT_ID) throw new UnauthorizedException('unknown agent');

    const userId = header(req, 'x-acting-for');
    const runId = header(req, 'x-run-id');
    if (!userId || !runId) {
      throw new UnauthorizedException('agent requests need x-acting-for and x-run-id');
    }
    if (!(await userExists(this.db, userId))) {
      throw new UnauthorizedException('x-acting-for is not a known user');
    }

    return {
      actor: { kind: 'agent', id: AGENT_ID, role: 'agent' },
      actingFor: { userId },
      runId,
      agentVersion: header(req, 'x-agent-version'),
      scopes: [],
    };
  }

  private userPrincipal(req: ApiRequest): Principal {
    const id = req.session?.user?.id;
    if (!id) throw new UnauthorizedException();
    return { actor: { kind: 'user', id, role: 'owner' }, scopes: [] };
  }
}

/** For actions only a person may take, such as approving what the agent asked for. */
@Injectable()
export class HumanOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const principal = context.switchToHttp().getRequest<ApiRequest>().principal;
    if (principal?.actor.kind !== 'user') throw new ForbiddenException('people only');
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<ApiRequest>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without PrincipalGuard');
  return principal;
});

export const RequestMeta = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestMeta => {
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    return {
      requestId: req.requestId ?? randomUUID(),
      idempotencyKey: header(req, 'idempotency-key'),
    };
  },
);
