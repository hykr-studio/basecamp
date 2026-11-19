// How the server calls a connector's provider: the egress guard (public addresses only, no
// redirects, a timeout, a size cap), and only the connector's own hosts (or ones the deployment
// lets through for development). Nothing goes out by plain fetch.
import { EgressBlocked, type OAuthHttp, safeRequest } from '@hykr/connectors';
import { outboundPolicy } from '../settings.js';
import { type OAuthConnector, oauthHosts } from './settings.js';

/** Bytes of a provider's answer kept: a page list or a lead fits. */
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

export function oauthHttp(c: OAuthConnector): OAuthHttp {
  const { hosts, allowHosts } = oauthHosts(c);
  const policy = {
    ...outboundPolicy(),
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
  return async (req) => {
    let host: string;
    try {
      host = new URL(req.url).hostname.toLowerCase();
    } catch {
      throw new EgressBlocked('not a URL');
    }
    if (!hosts.includes(host) && !allowHosts.includes(host))
      throw new EgressBlocked(`${host} is not one of ${c.name}'s hosts`);
    const res = await safeRequest(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      },
      policy,
    );
    let body: unknown = res.body || null;
    if (
      res.body &&
      (String(res.headers['content-type'] ?? '').includes('json') || /^[[{]/.test(res.body))
    )
      try {
        body = JSON.parse(res.body);
      } catch {
        body = res.body;
      }
    return { status: res.status, body };
  };
}
