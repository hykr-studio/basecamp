import { createHash, randomUUID } from 'node:crypto';
import { type Principal, SHARE_SESSION_HEADER } from '@hykr/contracts';
import { shareLinks, shareSessions } from '@hykr/db';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, gt } from 'drizzle-orm';
import type { Response } from 'express';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';
import { type ApiRequest, header } from './principal.js';
import { PrincipalResolver } from './resolver.js';

export type ShareLinkRow = typeof shareLinks.$inferSelect;

/** A request through a share link: the link as stored, and whether its code was entered. */
export type ShareRequest = ApiRequest & { share?: { link: ShareLinkRow; verified: boolean } };

/** sha256, hex: how a link's token and a session's are kept. */
export const shareHash = (token: string) => createHash('sha256').update(token).digest('hex');

const GATE_OPEN = 'core:share-gate-open';
/**
 * The routes a gated link answers before its code: what it is (its gate), asking for the code,
 * and entering it. Everything else waits for the session the code opens.
 */
export const ShareGateOpen = () => SetMetadata(GATE_OPEN, true);

const gone = (error: string, message: string) =>
  new HttpException({ error, message }, HttpStatus.GONE);

/**
 * Turns `/api/share/:token/…` into a guest principal (decisions B9): the link its token names
 * (404 when none: a token says nothing about anything else), refused once revoked or ended
 * (410), in the link's business, as `PrincipalResolver.forShareLink` makes it. A gated link
 * reaches only its gate routes (`@ShareGateOpen()`) until the request carries the session its
 * code opened (`x-share-session`); then the guest's assurance is `otp`. Never a session's or an
 * agent's principal: the share routes are anonymous for Better Auth, and only this guard serves
 * them.
 */
@Injectable()
export class ShareGuard implements CanActivate {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    private readonly reflector: Reflector,
    private readonly resolver: PrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest<ShareRequest>();
    const res = http.getResponse<Response>();
    req.requestId = header(req, 'x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', req.requestId);
    // Nobody's session or key counts here: the link is the only credential.
    const token = typeof req.params?.token === 'string' ? req.params.token : '';
    const link = /^[A-Za-z0-9_-]{20,100}$/.test(token) ? await this.linkOf(token) : undefined;
    if (!link) throw new NotFoundException({ error: 'not_found', message: 'No such link' });
    if (link.revokedAt) throw gone('link_revoked', 'This link was withdrawn');
    if (link.expiresAt <= new Date()) throw gone('link_expired', 'This link has ended');
    const verified = link.otpChannel ? await this.verified(link, req) : false;
    const open = this.reflector.getAllAndOverride<boolean>(GATE_OPEN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (link.otpChannel && !verified && !open)
      throw new UnauthorizedException({
        error: 'code_required',
        message: 'Enter the code sent to you to open this',
      });
    let principal: Principal;
    try {
      principal = await this.resolver.forShareLink(link, { verified });
    } catch (e) {
      // A shared page whose maker is no longer in the business: the link reaches nothing.
      if (e instanceof ForbiddenException || e instanceof UnauthorizedException)
        throw gone('link_revoked', 'This link was withdrawn');
      throw e;
    }
    req.principal = principal;
    req.share = { link, verified };
    return true;
  }

  private async linkOf(token: string): Promise<ShareLinkRow | undefined> {
    const [row] = await this.options.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, shareHash(token)));
    return row;
  }

  /** Does the request carry a live session this link's code opened? */
  private async verified(link: ShareLinkRow, req: ShareRequest): Promise<boolean> {
    const session = header(req, SHARE_SESSION_HEADER);
    if (!session || session.length > 200) return false;
    const [hit] = await this.options.db
      .select({ id: shareSessions.id })
      .from(shareSessions)
      .where(
        and(
          eq(shareSessions.tokenHash, shareHash(session)),
          eq(shareSessions.linkId, link.id),
          gt(shareSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return !!hit;
  }
}

/** The link a share route serves (set by `ShareGuard`). */
export function shareOf(req: ShareRequest): { link: ShareLinkRow; verified: boolean } {
  if (!req.share) throw new Error('A share route without ShareGuard');
  return req.share;
}
