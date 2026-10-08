import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Channel, type Principal } from '@app/contracts';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';
import { PrincipalResolver } from './resolver.js';

export type ApiRequest = Request & {
  /** Set by Better Auth's guard when the request carries a valid session. */
  session?: { user: { id: string; name?: string } } | null;
  principal?: Principal;
  requestId?: string;
};

export type RequestMetaValue = { requestId: string; idempotencyKey?: string };

export const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest();

const RELAY_ALLOWED = 'core:relay-allowed';
/**
 * The routes a relay agent (the voice worker) may call: starting a turn for its person, and
 * its own housekeeping. Everywhere else its key is refused, so a leaked relay key can never
 * read or write data directly; it can only ask the assistant, like the person would.
 */
export const RelayAllowed = () => SetMetadata(RELAY_ALLOWED, true);

/** A run id names a trace and audit rows: short, and safe to log. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Turns every request into exactly one principal before the handler runs: a signed-in
 * person, or the agent acting for one. Anything else is a 401.
 * Pair it with @OptionalAuth() so Better Auth attaches a session when there is one.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    private readonly reflector: Reflector,
    private readonly resolver: PrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<Response>();

    req.requestId = header(req, 'x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', req.requestId);

    const agentKey = header(req, 'x-agent-key');
    req.principal = agentKey
      ? await this.agentPrincipal(req, agentKey)
      : await this.userPrincipal(req);
    if (req.principal.actor.kind === 'agent') {
      const agent = this.options.agents.find((a) => a.id === req.principal?.actor.id);
      const allowed = this.reflector.getAllAndOverride<boolean>(RELAY_ALLOWED, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (agent?.relay && !allowed) throw new ForbiddenException('A relay can only start turns');
    }
    return true;
  }

  private async agentPrincipal(req: ApiRequest, agentKey: string): Promise<Principal> {
    // Hash both sides: equal lengths for timingSafeEqual, and nothing leaks the key's length.
    // A presented key that is wrong never falls back to the session. The key identifies the
    // agent; the claimed x-agent-id must match it.
    const presented = sha256(agentKey);
    const agent = this.options.agents.find(
      (a) => a.key.length > 0 && timingSafeEqual(presented, sha256(a.key)),
    );
    if (!agent) throw new UnauthorizedException('invalid agent key');
    if (header(req, 'x-agent-id') !== agent.id) {
      throw new UnauthorizedException('unknown agent');
    }
    const actingFor = header(req, 'x-acting-for');
    const runId = header(req, 'x-run-id');
    if (!actingFor || !runId) {
      throw new UnauthorizedException('agent requests need x-acting-for and x-run-id');
    }
    if (!RUN_ID.test(runId)) throw new UnauthorizedException('x-run-id is not a run id');
    // A relay's channel is fixed by its key; the assistant forwards the channel of the turn
    // it is running (checked against the known channels, never free text).
    const forwarded = Channel.safeParse(header(req, 'x-channel'));
    const channel = agent.channel ?? (forwarded.success ? forwarded.data : undefined);
    // Whom it acts for, in which business (one they belong to), with what roles: the server's.
    const standing = await this.resolver
      .forActingFor(actingFor, { tenantId: header(req, 'x-tenant-id'), channel })
      .catch((e) => {
        if (e instanceof UnauthorizedException)
          throw new UnauthorizedException('x-acting-for names nobody we know');
        throw e;
      });
    const subject = standing.subject;
    return {
      actor: { kind: 'agent', id: agent.id, role: 'agent' },
      actingFor:
        subject.kind === 'user' ? { userId: subject.userId } : { contactId: subject.contactId },
      ...standing,
      runId,
      agentVersion: header(req, 'x-agent-version'),
      scopes: [],
      ...(channel ? { channel } : {}),
    };
  }

  private async userPrincipal(req: ApiRequest): Promise<Principal> {
    const id = req.session?.user?.id;
    if (!id) throw new UnauthorizedException();
    const standing = await this.resolver.forUser(id, {
      tenantId: header(req, 'x-tenant-id'),
      name: req.session?.user?.name,
    });
    return { actor: { kind: 'user', id, role: 'owner' }, ...standing, scopes: [] };
  }
}

/**
 * A chat turn: a person, or a relay agent (the voice worker) starting a turn for the person it
 * acts for. The assistant itself never starts turns. Pair with @RelayAllowed() (and, for a
 * relay, a check that it is inside a session for that person; see the API's voice module).
 */
@Injectable()
export class ChatAccessGuard implements CanActivate {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  canActivate(context: ExecutionContext) {
    const p = context.switchToHttp().getRequest<ApiRequest>().principal;
    if (p?.actor.kind === 'user') return true;
    const agent = this.options.agents.find((a) => a.id === p?.actor.id);
    if (p?.actor.kind === 'agent' && agent?.relay && p.actingFor?.userId) return true;
    throw new ForbiddenException('Only people, or a relay acting for one, can start a turn');
  }
}

/** For actions only a person may take, such as deciding what the agent asked for. */
@Injectable()
export class HumanOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const principal = context.switchToHttp().getRequest<ApiRequest>().principal;
    if (principal?.actor.kind !== 'user') throw new ForbiddenException('Only people can do this');
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<ApiRequest>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without PrincipalGuard');
  return principal;
});

export const RequestMeta = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestMetaValue => {
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    return {
      requestId: req.requestId ?? randomUUID(),
      idempotencyKey: header(req, 'idempotency-key'),
    };
  },
);
