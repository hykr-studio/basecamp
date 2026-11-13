// GET /oauth/sign-in and GET /oauth/consent: the pages Better Auth's authorization endpoint sends
// a person to, with its signed query. Signing in and consenting are Better Auth's own endpoints
// (the pages call them); these only show what is asked, checked first.
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { parseScope, scopeOf } from '@hykr/contracts';
import { TenantConfigService } from '@hykr/core';
import { oauthClient } from '@hykr/db';
import { type Lang, langOf, languages, t } from '@hykr/i18n';
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { sharedDb } from '../../infra/db.js';
import { runtime } from '../../runtime.js';
import { mcpConfig } from './config.js';
import { businessOf, CONSENT_PATH, OFFLINE_SCOPE, SIGN_IN_PATH } from './oauth.js';
import { type ConsentChoice, consentPage, messagePage, PAGE_HEADERS, signInPage } from './pages.js';

type PageRequest = Request & { session?: { user?: { id: string; name?: string } } | null };

/**
 * The person's language: `?lang` when it is one the application speaks (put in the authorization
 * request, or added to the page's address), else the first of Accept-Language it speaks.
 */
const langFrom = (req: Request, query: URLSearchParams): Lang =>
  languages().of(query.get('lang')) ??
  langOf(
    String(req.headers['accept-language'] ?? '')
      .split(',')[0]
      ?.trim(),
  );

/** The query string exactly as sent. */
const rawQuery = (req: Request) => {
  const i = req.originalUrl.indexOf('?');
  return i < 0 ? '' : req.originalUrl.slice(i + 1);
};

/**
 * The part of the query the provider signed: the parameters it lists in `ba_param`, and the
 * signature. Anything added to the page's address after (a `lang`) is left out, here and in what
 * the page posts back, since the provider checks the whole `oauth_query` it is sent. A query that
 * lists none is kept whole (the check then refuses it).
 */
function signedPart(query: string): string {
  const params = new URLSearchParams(query);
  const names = new Set(params.getAll('ba_param'));
  const keep = (key: string) => key === 'sig' || key === 'ba_param' || names.has(key);
  if (!names.size || [...params.keys()].every(keep)) return query;
  const signed = new URLSearchParams();
  for (const [key, value] of params) if (keep(key)) signed.append(key, value);
  return signed.toString();
}

const send = (res: Response, status: number, html: string) =>
  res.status(status).set(PAGE_HEADERS).send(html);

@Controller()
@AllowAnonymous()
export class McpPagesController {
  constructor(@Inject(TenantConfigService) private readonly tenants: TenantConfigService) {}

  @Get(SIGN_IN_PATH.slice(1))
  async signIn(@Req() req: Request, @Res() res: Response) {
    const raw = rawQuery(req);
    const lang = langFrom(req, new URLSearchParams(raw));
    const app = runtime().definition.name;
    const query = signedPart(raw);
    if (!(await verifyOAuthQueryParams(query, config.authSecret)))
      return send(
        res,
        400,
        messagePage(lang, app, t(lang, 'mcp.consent.expired', { client: app })),
      );
    // A `lang` the page was given goes on to the consent screen, and only to it.
    const carry = languages().of(new URLSearchParams(raw).get('lang'));
    const consent = `${mcpConfig().base}${CONSENT_PATH}`;
    return send(res, 200, signInPage(lang, app, query, carry, consent));
  }

  @Get(CONSENT_PATH.slice(1))
  async consent(@Req() req: PageRequest, @Res() res: Response) {
    const raw = rawQuery(req);
    const lang = langFrom(req, new URLSearchParams(raw));
    const app = runtime().definition.name;
    const query = signedPart(raw);
    const params = new URLSearchParams(query);
    const clientId = params.get('client_id') ?? '';
    const [client] = clientId
      ? await sharedDb.db
          .select({ name: oauthClient.name, disabled: oauthClient.disabled })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, clientId))
          .limit(1)
      : [];
    const clientName = client?.name ?? clientId;
    if (!client || client.disabled || !(await verifyOAuthQueryParams(query, config.authSecret)))
      return send(
        res,
        400,
        messagePage(lang, app, t(lang, 'mcp.consent.expired', { client: clientName || app })),
      );
    const user = req.session?.user;
    if (!user?.id) return send(res, 401, messagePage(lang, app, t(lang, 'mcp.consent.signedOut')));
    // The business the token will act in (the plugin's referenceId).
    const tenantId = await businessOf(user.id, { create: false });
    const business = tenantId
      ? (await this.tenants.get(tenantId).catch(() => undefined))?.name
      : undefined;
    const asked = (params.get('scope') ?? '').split(' ').filter(Boolean);
    return send(
      res,
      200,
      consentPage(
        lang,
        { app, client: clientName, person: user.name ?? '', business: business ?? app },
        choices(asked, lang),
        query,
      ),
    );
  }
}

/**
 * The scopes asked for, as the person chooses among them: one row per module (read it, change
 * it if that was asked, or neither), and staying connected.
 */
function choices(scopes: readonly string[], lang: Lang): ConsentChoice[] {
  const catalog = runtime().catalog;
  const entitiesOf = (module: string) =>
    catalog.modules
      .find((m) => m.name === module)
      ?.entities.map((e) => catalog.entityByName(e)?.label ?? e)
      .join(', ');
  const rows: ConsentChoice[] = [];
  for (const scope of scopes) {
    if (scope === OFFLINE_SCOPE) {
      rows.push({ kind: 'offline', label: t(lang, 'mcp.consent.stayConnected') });
      continue;
    }
    const parsed = parseScope(scope);
    if (!parsed || rows.some((r) => r.kind === 'module' && r.module === parsed.module)) continue;
    const asked = (access: 'read' | 'write') => scopes.includes(scopeOf(parsed.module, access));
    const what = entitiesOf(parsed.module);
    rows.push({
      kind: 'module',
      module: parsed.module,
      label: `${parsed.module}${what ? ` (${what})` : ''}`,
      // Reading alone only when it was asked for (the provider takes no other scope).
      read: asked('read') ? scopeOf(parsed.module, 'read') : undefined,
      change: asked('write')
        ? [
            ...(asked('read') ? [scopeOf(parsed.module, 'read')] : []),
            scopeOf(parsed.module, 'write'),
          ].join(' ')
        : undefined,
    });
  }
  return rows;
}
