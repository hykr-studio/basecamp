// /api/mcp/connections: the outside AI clients a person connected in this business, and taking
// one back. People only (signed in, not an agent); the revocation goes through runWrite, so it is
// audited like any write.
import { type Principal, reserveRoutes } from '@hykr/contracts';
import {
  allow,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
  type WriteOp,
} from '@hykr/core';
import type { Database } from '@hykr/db';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { z } from 'zod';
import { DB } from '../../infra/db.module.js';
import { connectionsOf, revokeConnection } from './tokens.js';

// No module may take /api/mcp.
reserveRoutes('mcp');

const notFound = () => new NotFoundException({ error: 'not_found', message: 'No such connection' });

/** Disconnect one client from the person, in their business. */
const revoke = (clientId: string): WriteOp<Record<string, never>, null, { revoked: true }> => ({
  name: 'mcp.connection.revoke',
  kind: 'command',
  resourceType: 'mcp_connection',
  resourceId: () => clientId,
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  args: { clientId },
  load: async () => null,
  authorize: () => allow('own_connection', 'A person disconnects their own client'),
  summarize: () => 'Disconnect an outside AI client',
  async run({ tx, principal: p }) {
    const userId = p.subject?.kind === 'user' ? p.subject.userId : undefined;
    if (!userId || !p.tenantId) throw notFound();
    const done = await revokeConnection(tx, { userId, tenantId: p.tenantId, clientId });
    if (!done) throw notFound();
    return {
      value: { revoked: true },
      touched: [{ type: 'mcp_connection', id: clientId, change: 'deleted' }],
    };
  },
  present: (value) => value,
});

@Controller('api/mcp/connections')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class McpConnectionsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The clients this person connected in this business, newest first. */
  @Get()
  async list(@CurrentPrincipal() p: Principal) {
    const userId = p.subject?.kind === 'user' ? p.subject.userId : undefined;
    if (!userId || !p.tenantId) return { items: [] };
    return { items: await connectionsOf(this.db, userId, p.tenantId) };
  }

  /** Disconnect one: its consent goes and its tokens stop working at once. */
  @Delete(':clientId')
  @HttpCode(200)
  async remove(
    @CurrentPrincipal() p: Principal,
    @Param('clientId') clientId: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(clientId)) throw notFound();
    const { result } = await runWrite(
      this.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      revoke(clientId),
      {},
    );
    return result;
  }
}
