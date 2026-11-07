// GET /oauth/sign-in and GET /oauth/consent: the pages Better Auth's authorization endpoint sends
// a person to, with its signed query. Signing in and consenting are Better Auth's own endpoints
// (the pages call them); these only show what is asked, checked first.
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { parseScope } from '@hykr/contracts';
import { TenantConfigService } from '@hykr/core';
import { membershipOf, oauthClient } from '@hykr/db';
import { langOf, t } from '@hykr/i18n';
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { sharedDb } from '../../infra/db.js';
import { runtime } from '../../runtime.js';
import { CONSENT_PATH, OFFLINE_SCOPE, SIGN_IN_PATH } from './oauth.js';
import { type ConsentScope, consentPage, messagePage, PAGE_HEADERS, signInPage } from './pages.js';

type PageRequest = Request & { session?: { user?: { id: string; name?: string } } | null };

/** The person's language: the first of Accept-Language the product speaks. */
const langFrom = (req: Request) =>
  langOf(
    String(req.headers['accept-language'] ?? '')
      .split(',')[0]
      ?.trim(),
  );

/** The query string exactly as sent: the signature covers it. */
const rawQuery = (req: Request) => {
  const i = req.originalUrl.indexOf('?');
  return i < 0 ? '' : req.originalUrl.slice(i + 1);
};

const send = (res: Response, status: number, html: string) =>
  res.status(status).set(PAGE_HEADERS).send(html);

@Controller()
@AllowAnonymous()
export class McpPagesController {
  constructor(@Inject(TenantConfigService) private readonly tenants: TenantConfigService) {}

  @Get(SIGN_IN_PATH.slice(1))
  async signIn(@Req() req: Request, @Res() res: Response) {
    const lang = langFrom(req);
    const app = runtime().definition.name;
    if (!(await verifyOAuthQueryParams(rawQuery(req), config.authSecret)))
      return send(
        res,
        400,
        messagePage(lang, app, t(lang, 'mcp.consent.expired', { client: app })),
      );
    return send(res, 200, signInPage(lang, app));
  }

  @Get(CONSENT_PATH.slice(1))
  async consent(@Req() req: PageRequest, @Res() res: Response) {
    const lang = langFrom(req);
    const app = runtime().definition.name;
    const query = rawQuery(req);
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
    // The business the token will act in: the person's default one (the plugin's referenceId).
    const membership = await membershipOf(sharedDb.db, user.id);
    const business = membership
      ? (await this.tenants.get(membership.tenantId).catch(() => undefined))?.name
      : undefined;
    const asked = (params.get('scope') ?? '').split(' ').filter(Boolean);
    return send(
      res,
      200,
      consentPage(
        lang,
        { app, client: clientName, person: user.name ?? '', business: business ?? app },
        labelled(asked, lang),
      ),
    );
  }
}

/** The scopes asked for, worded: each module's read or change, and staying connected. */
function labelled(scopes: readonly string[], lang: ReturnType<typeof langOf>): ConsentScope[] {
  const catalog = runtime().catalog;
  const entitiesOf = (module: string) =>
    catalog.modules
      .find((m) => m.name === module)
      ?.entities.map((e) => catalog.entityByName(e)?.label ?? e)
      .join(', ');
  return scopes.map((scope) => {
    if (scope === OFFLINE_SCOPE) return { scope, label: t(lang, 'mcp.consent.stayConnected') };
    const parsed = parseScope(scope);
    if (!parsed) return { scope, label: scope };
    const what = entitiesOf(parsed.module);
    const access = t(lang, parsed.access === 'write' ? 'mcp.consent.write' : 'mcp.consent.read');
    return { scope, label: `${parsed.module}${what ? ` (${what})` : ''}: ${access}` };
  });
}
