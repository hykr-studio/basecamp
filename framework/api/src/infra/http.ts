// The API's own HTTP setup, shared by `startApi` and the tests' `boot`: which proxies Express
// believes about the caller's address (TRUST_PROXY), and the address every route and Better Auth
// count by.
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The caller's address as Express sees it (`req.ip`, which honours `trust proxy`), on every
 * request: Better Auth's rate limits count by it (`ipAddressHeaders`), as the API's throttle
 * counts by `req.ip`. A client's own value is always replaced, on every route.
 */
export const CLIENT_ADDRESS_HEADER = 'x-hykr-client-address';

/** Put the caller's address (`req.ip`) in `x-hykr-client-address`, over whatever was sent. */
export function stampClientAddress(req: Request): void {
  if (req.ip) req.headers[CLIENT_ADDRESS_HEADER] = req.ip;
  else delete req.headers[CLIENT_ADDRESS_HEADER];
}

/**
 * Express's `trust proxy` from TRUST_PROXY. Unset, empty, `false`, `off` or `0`: no proxy is
 * trusted, and the caller is the socket's address (the default, as before). `true` or `on`:
 * every proxy (only when nothing reaches the API but through them). A whole number: that many
 * hops in front of the API. Anything else is Express's list: addresses, subnets, or `loopback`,
 * `linklocal`, `uniquelocal`, comma separated.
 */
export function trustProxyOf(value: string | undefined): boolean | number | string {
  const v = (value ?? '').trim();
  if (!v || /^(false|off|no|0)$/i.test(v)) return false;
  if (/^(true|on|yes)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
}

/**
 * Before any route is mounted: `trust proxy` from TRUST_PROXY (read now, so a test can set it
 * before it boots), then the caller's address stamped on every request.
 */
export function configureHttp(nest: INestApplication): void {
  const express = nest.getHttpAdapter().getInstance() as { set(name: string, v: unknown): void };
  express.set('trust proxy', trustProxyOf(process.env.TRUST_PROXY));
  nest.use((req: Request, _res: Response, next: NextFunction) => {
    stampClientAddress(req);
    next();
  });
}
