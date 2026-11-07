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
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import { InboundService } from './inbound.service.js';
import { IntegrationsService } from './manage.service.js';

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
  constructor(private readonly integrations: IntegrationsService) {}

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
    return this.integrations.createEndpoint(p, meta.requestId, body);
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
    return this.integrations.updateEndpoint(p, meta.requestId, id, body);
  }

  @Delete('endpoints/:id')
  deleteEndpoint(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.deleteEndpoint(p, meta.requestId, id);
  }

  @Post('endpoints/:id/rotate')
  @HttpCode(200)
  rotate(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.rotateEndpoint(p, meta.requestId, id);
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
    return this.integrations.retryDelivery(p, meta.requestId, id);
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
    return this.integrations.createConnection(p, meta.requestId, body);
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
    return this.integrations.updateConnection(p, meta.requestId, id, body);
  }

  @Delete('connections/:id')
  deleteConnection(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Param('id', uuid) id: string,
  ) {
    return this.integrations.deleteConnection(p, meta.requestId, id);
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

const toInbound = (req: Request & { rawBody?: Buffer }): InboundRequest => ({
  rawBody: req.rawBody ?? Buffer.alloc(0),
  headers: req.headers,
  body: req.body,
  query: req.query as Record<string, unknown>,
});

/**
 * What outside systems send: `/webhooks/<connector>/<connection>`. Anonymous (the connector
 * verifies the request) and not throttled, like the WhatsApp webhook: it stores and queues,
 * and the work runs in the worker.
 */
@Controller('webhooks')
@AllowAnonymous()
@SkipThrottle()
export class WebhooksController {
  constructor(private readonly inbound: InboundService) {}

  @Post(':connector/:connection')
  @HttpCode(200)
  async receive(
    @Param('connector') connector: string,
    @Param('connection') connection: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    await this.inbound.receive(connector, connection, toInbound(req));
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
