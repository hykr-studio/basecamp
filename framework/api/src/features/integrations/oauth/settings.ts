// Signing a connector in (decisions B24): the deployment's settings, read from the environment
// when used (a test sets them before it boots the app). Per OAuth connector, under its
// `oauth.clientFrom` prefix <P>:
//   <P>_ID, <P>_SECRET            the deployment's OAuth client; unset: the connector is not offered
//   <P>_AUTHORIZE_URL, <P>_TOKEN_URL, <P>_REVOKE_URL, <P>_API_URL
//                                 where the provider is, when not where it says (a proxy, a fake);
//                                 https on the connector's hosts, or an INTEGRATIONS_ALLOWED_HOSTS host
//   <P>_<NAME>                    anything else its shared URL reads (Meta's <P>_VERIFY_TOKEN)
// And for every OAuth connector:
//   INTEGRATIONS_OAUTH_REDIRECT_URL   default <BETTER_AUTH_URL>/api/integrations/oauth/callback
//   INTEGRATIONS_RETURN_URL           where the browser goes after signing in (default <APP_URL>/integrations)
//   INTEGRATIONS_APP_RETURN_URL       the same for a native app (its deep link); unset: the web's
import {
  type Connector,
  type ConnectorOAuth,
  type OAuthClient,
  type OAuthEndpoints,
  oauthUrlProblem,
  type SharedApp,
} from '@hykr/connectors';
import { ServiceUnavailableException } from '@nestjs/common';
import { connectors } from '../registry.js';
import { outboundPolicy } from '../settings.js';

const trimmed = (v: string | undefined) => (v ?? '').trim();
const noSlash = (v: string) => v.replace(/\/+$/, '');

const authUrl = (env: NodeJS.ProcessEnv) =>
  noSlash(trimmed(env.BETTER_AUTH_URL) || 'http://localhost:3000');
const appUrl = (env: NodeJS.ProcessEnv) => noSlash(trimmed(env.APP_URL) || 'http://localhost:8081');

/** Where the provider sends the browser back: this server's callback. */
export const oauthRedirectUri = (env: NodeJS.ProcessEnv = process.env) =>
  trimmed(env.INTEGRATIONS_OAUTH_REDIRECT_URL) || `${authUrl(env)}/api/integrations/oauth/callback`;

/** Where the browser goes after signing in (with ?code=&state= or ?error=): the web app. */
export const oauthReturnUrl = (env: NodeJS.ProcessEnv = process.env) =>
  trimmed(env.INTEGRATIONS_RETURN_URL) || `${appUrl(env)}/integrations`;

/** The same for a native app: its deep link, or else the web app's. */
export const oauthAppReturnUrl = (env: NodeJS.ProcessEnv = process.env) =>
  trimmed(env.INTEGRATIONS_APP_RETURN_URL) || oauthReturnUrl(env);

/** A connector that signs in: its declaration with its name. */
export type OAuthConnector = Connector<unknown> & { oauth: ConnectorOAuth };

export const isOAuthConnector = (c: Connector<unknown> | undefined): c is OAuthConnector =>
  !!c?.oauth;

/** The deployment's OAuth client for a connector, or null when it has none (not offered). */
export function oauthClient(
  c: OAuthConnector,
  env: NodeJS.ProcessEnv = process.env,
): OAuthClient | null {
  const p = c.oauth.clientFrom;
  const clientId = trimmed(env[`${p}_ID`]);
  const clientSecret = trimmed(env[`${p}_SECRET`]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Where the provider is, as this deployment reaches it. */
export function oauthEndpoints(
  c: OAuthConnector,
  env: NodeJS.ProcessEnv = process.env,
): OAuthEndpoints {
  const p = c.oauth.clientFrom;
  const o = c.oauth;
  const revoke = trimmed(env[`${p}_REVOKE_URL`]) || o.revokeUrl;
  const api = trimmed(env[`${p}_API_URL`]) || o.apiUrl;
  return {
    authorize: trimmed(env[`${p}_AUTHORIZE_URL`]) || o.authorizeUrl,
    token: trimmed(env[`${p}_TOKEN_URL`]) || o.tokenUrl,
    ...(revoke ? { revoke } : {}),
    ...(api ? { api: noSlash(api) } : {}),
  };
}

/** The hosts a connector's calls may reach: its own, and the ones the deployment lets through. */
export function oauthHosts(c: OAuthConnector): { hosts: string[]; allowHosts: string[] } {
  return {
    hosts: c.oauth.hosts.map((h) => h.toLowerCase()),
    allowHosts: [...(outboundPolicy().allowHosts ?? [])],
  };
}

/** The deployment's app at the provider, for a shared URL; null without a client. */
export function sharedApp(
  c: OAuthConnector,
  env: NodeJS.ProcessEnv = process.env,
): SharedApp | null {
  const client = oauthClient(c, env);
  if (!client) return null;
  const p = c.oauth.clientFrom;
  return {
    ...client,
    setting: (name: string) => trimmed(env[`${p}_${name}`]) || undefined,
  };
}

/** The client, or 503 `oauth_unavailable`. */
export function requireClient(c: OAuthConnector): OAuthClient {
  const client = oauthClient(c);
  if (!client)
    throw new ServiceUnavailableException({
      error: 'unavailable',
      rule: 'oauth_unavailable',
      reason: `This server is not set up to connect ${c.name}`,
    });
  return client;
}

/**
 * At start: each OAuth connector's endpoints, as this deployment reaches them, are https on the
 * connector's hosts (or on a host the deployment lets through), and the return addresses parse.
 * A connector whose client is not set is not offered; that is not a problem.
 */
export function checkOAuthSettings(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  for (const c of connectors.all()) {
    if (!isOAuthConnector(c)) continue;
    const e = oauthEndpoints(c, env);
    const { hosts, allowHosts } = oauthHosts(c);
    for (const [name, url] of Object.entries(e)) {
      const problem = oauthUrlProblem(url, hosts, allowHosts);
      if (problem) problems.push(`${c.name} ${name}: ${problem}`);
    }
  }
  for (const [name, url] of [
    ['INTEGRATIONS_OAUTH_REDIRECT_URL', oauthRedirectUri(env)],
    ['INTEGRATIONS_RETURN_URL', oauthReturnUrl(env)],
    ['INTEGRATIONS_APP_RETURN_URL', oauthAppReturnUrl(env)],
  ])
    if (!URL.canParse(url)) problems.push(`${name} is not an address (got "${url}")`);
  if (problems.length) throw new Error(`OAuth connectors are set up wrong: ${problems.join('; ')}`);
}
