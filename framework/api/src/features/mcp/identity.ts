// An MCP client's access token as an agent identity (F4's chain): the client acts for the person
// who allowed it, in the business they allowed it in, limited to the scopes they allowed. The
// API's guards, rules, approvals and audit then treat it like any agent acting for that person.
import { type AgentIdentityProvider, RUN_ID } from '@hykr/core';
import { UnauthorizedException } from '@nestjs/common';
import { sharedDb } from '../../infra/db.js';
import { mcpConfig } from './config.js';
import { isAccessToken, type McpGrant, verifyAccessToken } from './tokens.js';

/** The agent id an MCP client is audited as. */
export const mcpAgentId = (clientId: string) => `mcp:${clientId}`;

/** `Authorization: Bearer <value>`, or undefined. */
export function bearerOf(headers: Record<string, unknown>): string | undefined {
  const value = headers.authorization;
  if (typeof value !== 'string') return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return m?.[1];
}

const checked = new WeakMap<object, { token: string; grant: Promise<McpGrant | null> }>();

/**
 * The grant behind a request's MCP access token, or null (none, not ours, or not valid). Checked
 * once per request: the throttle, PrincipalGuard and the MCP endpoint all ask, with the same
 * request's headers.
 */
export function grantOf(headers: Readonly<Record<string, unknown>>): Promise<McpGrant | null> {
  const token = bearerOf(headers);
  if (!token || !isAccessToken(token)) return Promise.resolve(null);
  const seen = checked.get(headers);
  if (seen?.token === token) return seen.grant;
  const grant = verifyAccessToken(sharedDb.db, token, mcpConfig().resource);
  checked.set(headers, { token, grant });
  return grant;
}

/** What the client says it is, short enough for an audit row. */
const versionOf = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 64);

export const mcpIdentityProvider: AgentIdentityProvider = {
  name: 'mcp',
  async identify(req) {
    const token = bearerOf(req.headers);
    // Not an MCP access token (no bearer, or another provider's): the next provider is asked.
    if (!token || !isAccessToken(token)) return null;
    const grant = await grantOf(req.headers);
    if (!grant) throw new UnauthorizedException('mcp: the token is not valid');
    // The MCP server names each tool call's run; a direct call gets one from the guard.
    const runId = req.headers['x-run-id'];
    return {
      agentId: mcpAgentId(grant.clientId),
      actingFor: { userId: grant.userId },
      tenantId: grant.tenantId,
      channel: 'mcp',
      ...(typeof runId === 'string' && RUN_ID.test(runId) ? { runId } : {}),
      agentVersion: versionOf(grant.clientName),
      scopes: grant.scopes,
    };
  },
};
