// Where the MCP endpoint and its authorization server live: deployment configuration, never code.
// Read from the environment when asked (tests and the CLI set it first).
import { config } from '../../config.js';

/** Access and refresh tokens carry these prefixes, so the identity provider knows its own. */
export const ACCESS_PREFIX = 'mcp_at_';
export const REFRESH_PREFIX = 'mcp_rt_';

/** The endpoint's path on the API. A deployment's own domain (MCP_URL) may proxy to it. */
export const MCP_PATH = '/mcp';

export interface McpConfig {
  /** The MCP endpoint's public URL: the resource tokens are issued for (MCP_URL). */
  resource: string;
  /** The API's own address (BETTER_AUTH_URL): pages and metadata. */
  base: string;
  /** The authorization server's issuer: Better Auth under /api/auth. */
  issuer: string;
  /** Where links to the app point (APP_URL): an approval's request. */
  appUrl: string;
}

const trimmed = (url: string) => url.replace(/\/+$/, '');

/** An absolute http(s) URL without query or fragment, or a clear error at startup. */
function checkUrl(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash)
    throw new Error(`${name} must be an http(s) URL without a query or fragment, not "${value}"`);
  return trimmed(url.toString());
}

/** MCP for this deployment: on unless MCP=off. */
export const mcpEnabled = () => process.env.MCP?.trim().toLowerCase() !== 'off';

export function mcpConfig(): McpConfig {
  const base = trimmed(config.authUrl);
  const resource = checkUrl('MCP_URL', process.env.MCP_URL?.trim() || `${base}${MCP_PATH}`);
  return { resource, base, issuer: `${base}/api/auth`, appUrl: config.appUrl };
}

/**
 * The protected resource metadata's address (RFC 9728): on the resource's own host, its path
 * after the well-known one. The API serves it at any path under that prefix.
 */
export function resourceMetadataUrl(c: McpConfig = mcpConfig()): string {
  const url = new URL(c.resource);
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
