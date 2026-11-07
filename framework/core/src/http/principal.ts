import { randomUUID } from 'node:crypto';
import {
  CHANNEL_HEADER,
  drivenByAgent,
  isReadOnlyChannel,
  isSessionChannel,
  type Principal,
} from '@hykr/contracts';
import {
  BadRequestException,
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
import type { AgentIdentity, AgentIdentityProvider } from '../hooks.js';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';
import { agentKeyProvider, identifyAgent } from './identity.js';
import { PrincipalResolver } from './resolver.js';

export type ApiRequest = Request & {
  /** Set by Better Auth's guard when the request carries a valid session. */
  session?: { user: { id: string; name?: string } } | null;
  principal?: Principal;
  /** The agent credential PrincipalGuard recognised (any identity provider's), if any. */
  agent?: AgentIdentity;
  requestId?: string;
};

export type RequestMetaValue = { requestId: string; idempotencyKey?: string };

export const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const RELAY_ALLOWED = 'core:relay-allowed';
/**
 * The routes a relay agent (the voice worker) may call: starting a turn for its person, and
 * its own housekeeping. Everywhere else its key is refused, so a leaked relay key can never
 * read or write data directly; it can only ask the assistant, like the person would.
 */
export const RelayAllowed = () => SetMetadata(RELAY_ALLOWED, true);

/** The methods a read-only channel may use. */
const READS = new Set(['GET', 'HEAD']);

/**
 * Turns every request into exactly one principal before the handler runs: an agent that an
 * identity provider recognises (the agent key first, then the contributed `identityProviders`),
 * acting for someone, or else a signed-in person. Anything else is a 401. It never makes a
 * system or guest principal: those are the server's own (`systemPrincipal`) or a share
 * guard's. Pair it with @OptionalAuth() so Better Auth attaches a session when there is one.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  private readonly keyed: AgentIdentityProvider;

  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    private readonly reflector: Reflector,
    private readonly resolver: PrincipalResolver,
  ) {
    this.keyed = agentKeyProvider(options.agents);
  }

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<Response>();

    req.requestId = header(req, 'x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', req.requestId);

    const identity = await identifyAgent(
      { method: req.method, path: req.path, headers: req.headers },
      this.keyed,
      this.options.agents.map((a) => a.id),
    );
    if (identity) {
      req.agent = identity;
      req.principal = await this.agentPrincipal(req, identity);
      const allowed = this.reflector.getAllAndOverride<boolean>(RELAY_ALLOWED, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (identity.relay && !allowed) throw new ForbiddenException('A relay can only start turns');
    } else {
      req.principal = await this.userPrincipal(req);
    }
    // A read-only channel (a page's WebMCP tools) reads, whoever it is: no write, command,
    // decision or turn reaches a handler.
    const channel = req.principal.channel;
    if (isReadOnlyChannel(channel) && !READS.has(req.method))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'read_only_channel',
        reason: `Calls on the ${channel} channel can only read`,
      });
    // Support access the business consented to read only: it reads, whoever drives it.
    const behalf = req.principal.onBehalfOf;
    if (behalf?.kind === 'support' && behalf.access === 'read' && !READS.has(req.method))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'support_read_only',
        reason: 'This support access can only read',
      });
    return true;
  }

  /** The agent, acting for whom it names, in a business that person belongs to: the server's facts. */
  private async agentPrincipal(req: ApiRequest, identity: AgentIdentity): Promise<Principal> {
    // A credential that fixes the business wins; a header naming another one is refused.
    const asked = header(req, 'x-tenant-id');
    if (identity.tenantId && asked && asked !== identity.tenantId)
      throw new ForbiddenException({ error: 'forbidden', rule: 'tenant_mismatch' });
    const { userId, contactId } = identity.actingFor;
    const named = userId
      ? ({ kind: 'user', userId } as const)
      : ({ kind: 'contact', contactId: contactId ?? '' } as const);
    const channel = identity.channel;
    const fixed = identity.tenantId ?? asked;
    // Whom it acts for, in which business (one they belong to), with what roles: the server's.
    // A linked WhatsApp contact comes back as its person.
    const standing = await this.resolver
      .forSubject(named, { tenantId: fixed, channel })
      .catch((e) => {
        if (e instanceof UnauthorizedException)
          throw new UnauthorizedException('x-acting-for names nobody we know');
        throw e;
      });
    // Whatever the subject (a contact of another business, a linked contact's person), the
    // principal acts in the business the credential or header fixed, or not at all.
    if (fixed && standing.tenantId !== fixed)
      throw new ForbiddenException({ error: 'forbidden', rule: 'tenant_mismatch' });
    return {
      actor: { kind: 'agent', id: identity.agentId },
      actingFor:
        standing.subject.kind === 'user'
          ? { userId: standing.subject.userId }
          : { contactId: standing.subject.contactId },
      ...standing,
      runId: identity.runId,
      agentVersion: identity.agentVersion,
      scopes: [...(identity.scopes ?? [])],
      ...(channel ? { channel } : {}),
    };
  }

  private async userPrincipal(req: ApiRequest): Promise<Principal> {
    const id = req.session?.user?.id;
    if (!id) throw new UnauthorizedException();
    // A signed-in browser may say which of its own channels calls (the app, the page's WebMCP
    // tools); it can never claim another (WhatsApp, background work, a share link).
    const named = header(req, CHANNEL_HEADER);
    if (named !== undefined && !isSessionChannel(named))
      throw new BadRequestException({
        error: 'bad_channel',
        reason: `A signed-in caller cannot name the channel "${named.slice(0, 40)}"`,
      });
    const standing = await this.resolver.forUser(id, {
      tenantId: header(req, 'x-tenant-id'),
      name: req.session?.user?.name,
      channel: named,
    });
    return {
      actor: { kind: 'user', id },
      ...standing,
      scopes: [],
      ...(named ? { channel: named } : {}),
    };
  }
}

/**
 * A chat turn: a person, or a relay agent (the voice worker) starting a turn for the person it
 * acts for. The assistant itself never starts turns. Pair with @RelayAllowed() (and, for a
 * relay, a check that it is inside a session for that person; see the API's voice module).
 */
@Injectable()
export class ChatAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const p = req.principal;
    // A person in no business yet has nobody to talk to: a thread belongs to a business.
    if (p && !p.tenantId)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'no_tenant',
        reason: 'You are not in a business yet',
      });
    if (p?.actor.kind === 'user' && !drivenByAgent(p)) return true;
    if (p?.actor.kind === 'agent' && req.agent?.relay && p.actingFor?.userId) return true;
    throw new ForbiddenException('Only people, or a relay acting for one, can start a turn');
  }
}

/**
 * For actions only a person may take, such as deciding what the agent asked for. Software on a
 * person's session (an agent-driven channel: a page's WebMCP tools) is refused like an agent.
 */
@Injectable()
export class HumanOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const principal = context.switchToHttp().getRequest<ApiRequest>().principal;
    if (principal?.actor.kind !== 'user' || drivenByAgent(principal))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'humans_only',
        reason: 'Only people can do this',
      });
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
