// Connecting a business by signing in (decisions B21): start (the consent screen's URL), the
// provider's callback (anonymous: it only sends the browser on, as the calendar's does), and
// complete (the code exchanged under the session of the person who started, in that business),
// then picking the accounts the connection receives events for. As the calendar's sign-in
// (decisions B17, 36 and 37), made generic over connectors and owned by the business.
import { randomUUID } from 'node:crypto';
import {
  type ConnectorRequestInit,
  isOAuthError,
  type OAuthAccount,
  type OAuthTokens,
  oauthAuthorizationUrl,
  oauthExchangeCode,
  pkcePair,
} from '@hykr/connectors';
import type { Principal } from '@hykr/contracts';
import {
  findRepeat,
  oneAtATime,
  requireCapability,
  runWrite,
  type WriteCtx,
  type WriteOp,
  type WriteOutcome,
} from '@hykr/core';
import { type Database, integrationAccounts, integrationConnections } from '@hykr/db';
import { subjectOf } from '@hykr/policy';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { DB } from '../../../infra/db.module.js';
import { IntegrationsCapability } from '../capability.js';
import {
  accountView,
  OAuthComplete,
  OAuthPick,
  OAuthStart,
  oauthConnectOp,
  oauthPickOp,
} from '../ops.js';
import { connectors } from '../registry.js';
import { requireSecretBox } from '../settings.js';
import {
  isOAuthConnector,
  type OAuthConnector,
  oauthAppReturnUrl,
  oauthEndpoints,
  oauthRedirectUri,
  oauthReturnUrl,
  requireClient,
} from './settings.js';
import { beginSignIn, findSignIn, takeSignIn, verifierOf } from './sign-in.js';
import { accountAad, connectorRequest, oauthContext, sealGrant } from './tokens.js';

const log = new Logger('OAuthConnections');

/** What a request sends, checked, or 400 with the problems. */
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success)
    throw new BadRequestException({
      error: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return parsed.data;
}

const refused = (rule: string, reason: string, more: Record<string, unknown> = {}) =>
  new BadRequestException({ error: 'invalid', rule, reason, ...more });

/** The browser's next stop, with what it carries back. */
function landing(base: string, params: Record<string, string>) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const userOf = (p: Principal) => {
  const s = subjectOf(p);
  if (s?.kind !== 'user')
    throw new ForbiddenException({
      error: 'forbidden',
      rule: 'members_only',
      reason: 'Only a member of the business connects it to another service',
    });
  return s.userId;
};

/** At most this many accounts are kept from one sign-in. */
const MAX_ACCOUNTS = 200;

/** Who asks, and how to recognise their retry: the request's id and idempotency-key. */
export type OAuthWriteMeta = { requestId: string; idempotencyKey?: string };

// biome-ignore lint/suspicious/noExplicitAny: any of the feature's ops
type AnyOp = WriteOp<any, any, any>;

@Injectable()
export class OAuthConnectionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  private manage(p: Principal) {
    requireCapability(p, IntegrationsCapability, {
      rule: 'integrations_manage_needed',
      reason: 'Only people who manage integrations can connect services',
    });
    if (!p.tenantId)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'no_business',
        reason: 'Connect a service from within a business',
      });
    return p.tenantId;
  }

  private connector(name: string): OAuthConnector {
    const c = connectors.get(name);
    if (!c) throw new BadRequestException({ error: 'invalid', message: `No connector ${name}` });
    if (!isOAuthConnector(c))
      throw refused(
        'oauth_not_offered',
        `${name} is connected with credentials, not by signing in`,
      );
    return c;
  }

  private ctx(p: Principal, meta: OAuthWriteMeta, requestBody?: unknown): WriteCtx {
    return {
      principal: p,
      requestId: meta.requestId,
      ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
    };
  }

  private async run(
    p: Principal,
    meta: OAuthWriteMeta,
    op: AnyOp,
    input: unknown,
    requestBody?: unknown,
  ): Promise<WriteOutcome> {
    const out = await runWrite(this.db, this.ctx(p, meta, requestBody), op, input);
    for (const event of out.events) this.events.publish(event);
    return out;
  }

  /** A connection's answer with its accounts (ids and names, never tokens). */
  async withAccounts(result: WriteOutcome['result']) {
    if (result.status !== 'done') return result;
    const value = result.value as { id?: string } | null;
    if (!value?.id) return result;
    const accounts = await this.db
      .select()
      .from(integrationAccounts)
      .where(eq(integrationAccounts.connectionId, value.id))
      .orderBy(asc(integrationAccounts.name));
    return { ...result, value: { ...value, accounts: accounts.map(accountView) } };
  }

  /** The consent screen's URL, for a person who manages this business's integrations. */
  async start(p: Principal, body: unknown): Promise<{ url: string }> {
    const input = parse(OAuthStart, body);
    const tenantId = this.manage(p);
    const userId = userOf(p);
    const c = this.connector(input.connector);
    const client = requireClient(c);
    requireSecretBox();
    if (input.connectionId) {
      const [row] = await this.db
        .select({ connector: integrationConnections.connector })
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.id, input.connectionId),
            eq(integrationConnections.tenantId, tenantId),
          ),
        );
      if (!row || row.connector !== c.name)
        throw new NotFoundException({ error: 'not_found', message: 'No such connection' });
    }
    const pkce = c.oauth.pkce === false ? null : pkcePair();
    // The verifier stays here, under a random state: the URL carries nothing it could be read from.
    const state = await beginSignIn(this.db, {
      tenantId,
      userId,
      connector: c.name,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.label ? { label: input.label } : {}),
      verifier: pkce?.verifier ?? '-',
      returnTo: input.returnTo === 'app' ? oauthAppReturnUrl() : oauthReturnUrl(),
    });
    return {
      url: oauthAuthorizationUrl({
        oauth: c.oauth,
        endpoints: oauthEndpoints(c),
        clientId: client.clientId,
        redirectUri: oauthRedirectUri(),
        state,
        ...(pkce ? { codeChallenge: pkce.challenge } : {}),
      }),
    };
  }

  /**
   * The provider sends the browser back here, with no session to trust. Nothing is exchanged:
   * the browser goes on to the app (an address of the deployment's, never the request's), with
   * the code and the state, and the app finishes under its own session (`complete`).
   */
  async callback(query: Record<string, unknown>): Promise<string> {
    const signIn = await findSignIn(this.db, query.state);
    if (!signIn) return landing(oauthReturnUrl(), { error: 'sign_in_expired' });
    if (typeof query.error === 'string') {
      // The person said no (or the provider could not ask): this sign-in is over.
      await takeSignIn(this.db, query.state);
      const error = query.error === 'access_denied' ? 'oauth_refused' : query.error.slice(0, 100);
      return landing(signIn.returnTo, { error });
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || code.length > 4096) return landing(signIn.returnTo, { error: 'no_code' });
    return landing(signIn.returnTo, { code, state: query.state as string });
  }

  /**
   * The app finishes a sign-in under the session of the person who started it, in the business
   * they started it in. The sign-in is taken first, so a refused try also ends it. A retry with
   * the same idempotency-key answers the first answer; one sent while the first still runs
   * waits for it.
   */
  async complete(p: Principal, meta: OAuthWriteMeta, body: unknown) {
    const input = parse(OAuthComplete, body);
    this.manage(p);
    const userId = userOf(p);
    const op = oauthConnectOp();
    const ctx = this.ctx(p, meta);
    return oneAtATime(this.db, ctx, async () => {
      const repeat = await findRepeat(this.db, ctx, op, input);
      if (repeat) return this.withAccounts(repeat.result);
      return this.connect(p, meta, input, userId, op);
    });
  }

  private async connect(
    p: Principal,
    meta: OAuthWriteMeta,
    input: z.infer<typeof OAuthComplete>,
    userId: string,
    op: AnyOp,
  ) {
    const box = requireSecretBox();
    const signIn = await takeSignIn(this.db, input.state);
    if (!signIn)
      throw refused(
        'oauth_sign_in_invalid',
        'This sign-in is old or was used already: start again',
      );
    if (signIn.userId !== userId) {
      log.warn(`connection sign-in of ${signIn.userId} refused to ${userId}: not theirs`);
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'oauth_not_yours',
        reason: 'Someone else started this sign-in, so nothing was connected. Start one yourself.',
      });
    }
    if (signIn.tenantId !== p.tenantId)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'oauth_other_business',
        reason:
          'This sign-in was started in another business, so nothing was connected. Start again here.',
      });
    const tenantId = signIn.tenantId;
    const c = this.connector(signIn.connector);
    const ctx = oauthContext(c);
    let codeVerifier: string;
    try {
      codeVerifier = verifierOf(signIn);
    } catch {
      // Sealed with a key this server no longer has.
      throw refused('oauth_sign_in_invalid', 'This sign-in cannot be finished: start again');
    }
    let tokens: OAuthTokens;
    try {
      tokens = await oauthExchangeCode(ctx.http, {
        endpoints: ctx.endpoints,
        client: ctx.client,
        code: input.code,
        redirectUri: oauthRedirectUri(),
        ...(c.oauth.pkce === false ? {} : { codeVerifier }),
      });
      if (c.oauth.exchange) tokens = await c.oauth.exchange(tokens, ctx);
    } catch (e) {
      log.warn(`${c.name} refused the code: ${e instanceof Error ? e.message : String(e)}`);
      if (isOAuthError(e))
        throw refused(
          'oauth_exchange_refused',
          `${c.name} did not accept this sign-in: start again`,
        );
      throw e;
    }
    const grantedScopes = c.oauth.grantedScopes;
    const granted =
      tokens.scopes ??
      (grantedScopes
        ? await this.asked(c.name, () => grantedScopes(tokens, ctx))
        : [...c.oauth.scopes]);
    const missing = c.oauth.scopes.filter((s) => !granted.includes(s));
    if (missing.length)
      throw refused(
        'oauth_scopes_missing',
        `The sign-in did not allow everything ${c.name} needs (${missing.join(', ')}): connect again and allow them`,
        { missing },
      );
    const describe = c.oauth.describe;
    const description = describe ? await this.asked(c.name, () => describe(tokens, ctx)) : {};
    const seen = new Set<string>();
    const accounts: OAuthAccount[] = [];
    for (const a of description.accounts ?? []) {
      if (!a.id || a.id.length > 200 || seen.has(a.id)) continue;
      seen.add(a.id);
      accounts.push(a);
      if (accounts.length >= MAX_ACCOUNTS) break;
    }
    const id = signIn.connectionId ?? randomUUID();
    const hold = !c.oauth.pick;
    const { result } = await this.run(
      p,
      meta,
      op,
      {
        id,
        connector: c.name,
        ...(signIn.label ? { label: signIn.label } : {}),
        reconnect: !!signIn.connectionId,
        sealed: sealGrant(tenantId, id, { ...tokens, scopes: granted }),
        scopes: granted.slice(0, 100),
        tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
        public: Object.fromEntries(
          Object.entries(description.public ?? {}).map(([k, v]) => [k, String(v).slice(0, 500)]),
        ),
        accounts: accounts.map((a) => ({
          accountId: a.id,
          name: (a.name ?? a.id).slice(0, 500),
          ...(a.token ? { tokenSealed: box.seal(a.token, accountAad(tenantId, id, a.id)) } : {}),
          held: hold,
        })),
      },
      input,
    );
    return this.withAccounts(result);
  }

  /** A provider call after the exchange: its refusal is the sign-in's, said as a 400. */
  private async asked<T>(connector: string, ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (e) {
      if (!isOAuthError(e)) throw e;
      log.warn(`${connector} refused a call after signing in: ${e.message}`);
      throw refused(
        'oauth_provider_refused',
        `${connector} refused to say what this sign-in reaches: start again`,
      );
    }
  }

  /**
   * The accounts the connection receives events for, of those its sign-in found; each one
   * picked is subscribed at the provider (after the write: a failure is said, per account).
   */
  async pick(p: Principal, meta: OAuthWriteMeta, id: string, body: unknown) {
    const input = parse(OAuthPick, body);
    const tenantId = this.manage(p);
    const [row] = await this.db
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.id, id), eq(integrationConnections.tenantId, tenantId)));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such connection' });
    const c = this.connector(row.connector);
    if (!c.oauth.pick)
      throw refused('oauth_no_pick', `${c.name} receives events for every account it reaches`);
    const out = await this.run(p, meta, oauthPickOp({ id }), input);
    const answer = await this.withAccounts(out.result);
    if (out.result.status !== 'done' || out.repeat) return answer;
    const subscribe = c.oauth.pick.subscribe;
    const call = (init: ConnectorRequestInit) =>
      connectorRequest(this.db, { tenantId, connectionId: id }, init);
    const subscribed: { id: string; ok: boolean; error?: string }[] = [];
    for (const accountId of [...new Set(input.accountIds)]) {
      try {
        await subscribe({ id: accountId, name: accountId }, call);
        subscribed.push({ id: accountId, ok: true });
      } catch (e) {
        const error = e instanceof Error ? e.message.slice(0, 300) : String(e);
        log.warn(`Subscribing ${c.name} account ${accountId} failed: ${error}`);
        subscribed.push({ id: accountId, ok: false, error });
      }
    }
    return { ...answer, subscribed };
  }

  /** A connection's accounts, by connection: for the list. */
  async accountsByConnection(tenantId: string) {
    const rows = await this.db
      .select()
      .from(integrationAccounts)
      .where(eq(integrationAccounts.tenantId, tenantId))
      .orderBy(asc(integrationAccounts.name));
    const by = new Map<string, ReturnType<typeof accountView>[]>();
    for (const r of rows)
      by.set(r.connectionId, [...(by.get(r.connectionId) ?? []), accountView(r)]);
    return by;
  }
}
