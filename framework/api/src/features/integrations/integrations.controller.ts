import type { InboundRequest } from '@hykr/connectors';
import type { Principal } from '@hykr/contracts';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
} from '@hykr/core';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Next,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { NextFunction, Request, Response } from 'express';
import { InboundService } from './inbound.service.js';
import { IntegrationsService } from './manage.service.js';
import { OAuthConnectionsService } from './oauth/oauth.service.js';

const uuid = new ParseUUIDPipe();

/**
 * The business's integrations, for people with `integrations.manage`: connectors, webhook
 * endpoints and their delivery log, connections and what they received. Never the assistant:
 * nothing here is a tool, and an agent's call is refused.
 */
@Controller('api/integrations')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly oauth: OAuthConnectionsService,
  ) {}

  @Get('connectors')
  connectors(@CurrentPrincipal() p: Principal) {
    return this.integrations.listConnectors(p);
  }

  @Get('endpoints')
  endpoints(@CurrentPrincipal() p: Principal) {
    return this.integrations.listEndpoints(p);
  }

  @Post('endpoints')
  createEndpoint(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    return this.integrations.createEndpoint(p, meta, body);
  }

  @Get('endpoints/:id')
  endpoint(@CurrentPrincipal() p: Principal, @Param('id', uuid) id: string) {
    return this.integrations.getEndpoint(p, id);
  }

  @Patch('endpoints/:id')
  updateEndpoint(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.integrations.updateEndpoint(p, meta, id, body);
  }

  @Delete('endpoints/:id')
  deleteEndpoint(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.deleteEndpoint(p, meta, id);
  }

  @Post('endpoints/:id/rotate')
  @HttpCode(200)
  rotate(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.rotateEndpoint(p, meta, id);
  }

  @Get('endpoints/:id/deliveries')
  deliveries(
    @CurrentPrincipal() p: Principal,
    @Param('id', uuid) id: string,
    @Query() query: { status?: string; before?: string; limit?: string },
  ) {
    return this.integrations.deliveries(p, id, query);
  }

  @Get('deliveries/:id')
  delivery(@CurrentPrincipal() p: Principal, @Param('id', uuid) id: string) {
    return this.integrations.delivery(p, id);
  }

  @Post('deliveries/:id/retry')
  @HttpCode(200)
  retry(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.retryDelivery(p, meta, id);
  }

  @Get('connections')
  connections(@CurrentPrincipal() p: Principal) {
    return this.integrations.listConnections(p);
  }

  @Post('connections')
  createConnection(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    return this.integrations.createConnection(p, meta, body);
  }

  /** Connect by signing in: the provider's consent screen, to open in the browser. */
  @Post('connections/oauth/start')
  @HttpCode(200)
  oauthStart(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.oauth.start(p, body);
  }

  /** Finish signing in with what the provider sent the browser back with. */
  @Post('connections/oauth/complete')
  oauthComplete(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    return this.oauth.complete(p, meta, body);
  }

  /** The accounts (pages) a signed-in connection receives events for. */
  @Post('connections/:id/oauth/pick')
  @HttpCode(200)
  oauthPick(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.oauth.pick(p, meta, id, body);
  }

  @Get('connections/:id')
  connection(@CurrentPrincipal() p: Principal, @Param('id', uuid) id: string) {
    return this.integrations.getConnection(p, id);
  }

  @Patch('connections/:id')
  updateConnection(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.integrations.updateConnection(p, meta, id, body);
  }

  @Delete('connections/:id')
  deleteConnection(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.deleteConnection(p, meta, id);
  }

  @Get('connections/:id/inbound')
  inbound(
    @CurrentPrincipal() p: Principal,
    @Param('id', uuid) id: string,
    @Query() query: { status?: string; limit?: string },
  ) {
    return this.integrations.inbound(p, id, query);
  }
}

/**
 * Where a provider sends the browser back after signing in. Anonymous: it exchanges nothing, and
 * sends the browser on to the deployment's app with the code and the state.
 */
@Controller('api/integrations')
@AllowAnonymous()
export class IntegrationsOAuthCallbackController {
  constructor(private readonly oauth: OAuthConnectionsService) {}

  @Get('oauth/callback')
  @Redirect()
  async callback(@Query() query: Record<string, unknown>) {
    return { url: await this.oauth.callback(query), statusCode: 302 };
  }
}

const toInbound = (req: Request & { rawBody?: Buffer }): InboundRequest => ({
  rawBody: req.rawBody ?? Buffer.alloc(0),
  headers: req.headers,
  body: req.body,
  query: req.query as Record<string, unknown>,
});

/**
 * What outside systems send: `/webhooks/<connector>/<connection>`, or `/webhooks/<connector>` for
 * a provider that posts everything to one URL (routed by account, decisions B24). Anonymous (the
 * connector verifies the request) and not throttled, like the WhatsApp webhook: it stores and
 * queues, and the work runs in the worker.
 */
@Controller('webhooks')
@AllowAnonymous()
@SkipThrottle()
export class WebhooksController {
  constructor(private readonly inbound: InboundService) {}

  /*
   * A provider's one URL. Express 5 cannot constrain `:connector`, and this controller is
   * mounted before the channels' (`/webhooks/whatsapp`): a name that is not a shared connector
   * is passed on (`next()`), to the route that owns it or to the 404.
   */
  @Post(':connector')
  async receiveShared(
    @Param('connector') connector: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (!this.inbound.isShared(connector)) return next();
    await this.inbound.receiveShared(connector, toInbound(req));
    res.status(200).type('text/plain').send('ok');
  }

  @Get(':connector')
  async challengeShared(
    @Param('connector') connector: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (!this.inbound.isShared(connector)) return next();
    const answer = await this.inbound.challengeShared(connector, toInbound(req));
    if (answer === null) throw new ForbiddenException('no challenge here');
    res.status(200).type('text/plain; charset=utf-8').send(answer);
  }

  @Post(':connector/:connection')
  @HttpCode(200)
  async receive(
    @Param('connector') connector: string,
    @Param('connection') connection: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.inbound.receive(connector, connection, toInbound(req));
    if ('handshake' in out) {
      // The sender's own token, echoed as plain text (never as HTML).
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('x-content-type-options', 'nosniff');
      return out.handshake;
    }
    return 'ok';
  }

  @Get(':connector/:connection')
  @Header('content-type', 'text/plain; charset=utf-8')
  async challenge(
    @Param('connector') connector: string,
    @Param('connection') connection: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const answer = await this.inbound.challenge(connector, connection, toInbound(req));
    if (answer === null) throw new ForbiddenException('no challenge here');
    return answer;
  }
}
