// The MCP endpoint (`/mcp`) and the metadata an MCP client discovers it with: the protected
// resource (RFC 9728) and its authorization server (RFC 8414). A call without a valid token is
// answered 401 with a challenge naming the metadata, so the client can start OAuth.
import { PrincipalResolver } from '@hykr/core';
import {
  All,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Request, Response } from 'express';
import { getAuth } from '../../infra/auth.js';
import { runtime } from '../../runtime.js';
import { MCP_PATH, mcpConfig, resourceMetadataUrl } from './config.js';
import { bearerOf, grantOf } from './identity.js';
import { mcpScopes } from './oauth.js';
import { type McpAuthInfo, McpServers } from './server.js';

/** The challenge a client without a valid token gets: where to learn how to sign in. */
function challenge(res: Response, error?: 'invalid_token') {
  const params = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${resourceMetadataUrl()}"`,
  ];
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer ${params.join(', ')}`)
    .json({
      error: error ?? 'unauthorized',
      // One it was sent but does not accept (unknown, revoked or expired), or none at all.
      error_description: error
        ? 'The access token is invalid, expired or revoked'
        : 'A bearer token is needed',
    });
}

@Controller()
@AllowAnonymous()
export class McpController {
  constructor(
    @Inject(McpServers) private readonly servers: McpServers,
    @Inject(PrincipalResolver) private readonly resolver: PrincipalResolver,
  ) {}

  /** MCP over Streamable HTTP, for a client holding an access token. */
  @All(MCP_PATH.slice(1))
  async serve(@Req() req: Request & { auth?: McpAuthInfo }, @Res() res: Response) {
    const c = mcpConfig();
    const token = bearerOf(req.headers);
    if (!token) return challenge(res);
    const grant = await grantOf(req.headers);
    if (!grant) return challenge(res, 'invalid_token');
    // Still a member of the business the token acts in (the API checks it again on every call).
    try {
      await this.resolver.forUser(grant.userId, { tenantId: grant.tenantId, channel: 'mcp' });
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof UnauthorizedException) {
        res.status(403).json({ error: 'forbidden', rule: 'not_a_member' });
        return;
      }
      throw e;
    }
    req.auth = {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
      resource: new URL(c.resource),
      extra: { userId: grant.userId, tenantId: grant.tenantId, sub: grant.userId },
    };
    const url = new URL(req.originalUrl, 'http://localhost');
    // The tools of what the business has switched off are not listed (A11, fail closed).
    const server = await this.servers.for(grant.scopes, grant.tenantId);
    await server.startHTTP({ url, httpPath: MCP_PATH, req, res });
  }
}

/** The documents a client reads to find the authorization server. */
@Controller('.well-known')
@AllowAnonymous()
export class McpMetadataController {
  /** RFC 9728: this resource, who issues its tokens, and the scopes (the application's modules). */
  @Get(['oauth-protected-resource', 'oauth-protected-resource/*path'])
  protectedResource() {
    const c = mcpConfig();
    return {
      resource: c.resource,
      authorization_servers: [c.issuer],
      scopes_supported: mcpScopes(),
      bearer_methods_supported: ['header'],
      resource_name: runtime().definition.name,
    };
  }

  /** RFC 8414 at the root (and with the issuer's path inserted): Better Auth's own document. */
  @Get(['oauth-authorization-server', 'oauth-authorization-server/*path'])
  async authorizationServer() {
    const api = getAuth().api as unknown as { getOAuthServerConfig(): Promise<unknown> };
    return api.getOAuthServerConfig();
  }
}
