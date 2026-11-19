// Facebook and Instagram lead ads (decisions B24): a business signs in with Facebook, picks the
// pages whose lead forms it wants, and Meta posts each new lead to the app's one webhook URL,
// `/webhooks/meta-leads`, signed with the app's secret and naming the page. The page ids come from
// Meta's own answer at sign-in (`/me/accounts`), so a lead reaches only the business holding its
// page. Each notice names a lead; `expand` fetches its answers with the page's token, once.
// Instagram lead forms belong to the Facebook page the Instagram account is linked to.
import { z } from 'zod';
import { defineConnector, readHeader } from '../connector.js';
import { verifyHmac } from '../hmac.js';
import {
  type OAuthContext,
  type OAuthResponse,
  type OAuthTokens,
  oauthCredentials,
  oauthError,
} from '../oauth.js';

export const META_LEADS_CONNECTOR = 'meta-leads';
/** The type of a notice as received: it names a lead. */
export const LEADGEN_EVENT = 'leadgen';
/** The type of a lead once fetched: what a handler takes. */
export const LEAD_EVENT = 'lead';

export const META_GRAPH_VERSION = 'v21.0';

/** One answer on a lead form. */
export interface MetaLeadField {
  name: string;
  values: string[];
}

/** A lead, as a handler receives it (`lead` events). */
export interface MetaLead {
  leadId: string;
  /** The Facebook page the form is on. */
  pageId: string;
  /** The lead form's id. */
  form: string | null;
  /** The ad's id; null for a form opened another way (an organic post, a test). */
  ad: string | null;
  fields: MetaLeadField[];
  /** When the person sent the form (ISO 8601). */
  createdAt: string;
}

/** A notice as Meta posts it: the ids only. */
export interface MetaLeadNotice {
  leadId: string;
  pageId: string;
  form: string | null;
  ad: string | null;
  createdTime: number | null;
}

/** Meta's error 190: the token is expired or withdrawn. */
const isTokenError = (res: OAuthResponse) => {
  const error = (res.body as { error?: { code?: unknown } } | null)?.error;
  return Number(error?.code) === 190;
};

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
});

async function graphGet(ctx: OAuthContext, path: string, token: string, what: string) {
  const res = await ctx.http({ method: 'GET', url: ctx.api(path), headers: bearer(token) });
  if (res.status !== 200) throw oauthError(res.status, res.body, what);
  return res.body;
}

const Pages = z.object({
  data: z.array(
    z.object({ id: z.string(), name: z.string(), access_token: z.string().optional() }),
  ),
});

const Permissions = z.object({
  data: z.array(z.object({ permission: z.string(), status: z.string() })),
});

const Lead = z.object({
  id: z.string(),
  created_time: z.string().optional(),
  form_id: z.string().optional(),
  ad_id: z.string().optional(),
  field_data: z
    .array(z.object({ name: z.string(), values: z.array(z.unknown()).optional() }))
    .optional(),
});

const Notice = z.object({
  object: z.string().optional(),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z
        .array(
          z.object({
            field: z.string(),
            value: z
              .object({
                leadgen_id: z.union([z.string(), z.number()]).optional(),
                page_id: z.union([z.string(), z.number()]).optional(),
                form_id: z.union([z.string(), z.number()]).optional(),
                ad_id: z.union([z.string(), z.number()]).optional(),
                created_time: z.number().optional(),
              })
              .passthrough(),
          }),
        )
        .optional(),
    }),
  ),
});

const str = (v: string | number | undefined) => (v === undefined ? null : String(v));

/** The leads a webhook body names, one notice each. */
export function noticesOf(body: unknown): MetaLeadNotice[] {
  const parsed = Notice.parse(body);
  const notices: MetaLeadNotice[] = [];
  for (const entry of parsed.entry)
    for (const change of entry.changes ?? []) {
      if (change.field !== LEADGEN_EVENT) continue;
      const v = change.value;
      const leadId = str(v.leadgen_id);
      const pageId = str(v.page_id) ?? entry.id ?? null;
      if (!leadId || !pageId) throw new Error('A leadgen change names no lead or no page');
      notices.push({
        leadId,
        pageId,
        form: str(v.form_id),
        ad: str(v.ad_id),
        createdTime: v.created_time ?? null,
      });
    }
  return notices;
}

export interface MetaLeadsOptions {
  /** The Graph API version in Meta's URLs. Default v21.0. */
  graphVersion?: string;
}

/**
 * The Facebook and Instagram lead ads connector. The deployment sets META_APP_ID,
 * META_APP_SECRET (which also signs Meta's webhook posts) and META_APP_VERIFY_TOKEN (what Meta's
 * subscription check sends back), and registers `<server>/webhooks/meta-leads` as the app's
 * webhook for the `leadgen` field of pages. `leads_retrieval` needs Meta's app review.
 */
export function metaLeads(options: MetaLeadsOptions = {}) {
  const v = options.graphVersion ?? META_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(v)) throw new Error(`"${v}" is not a Graph API version like v21.0`);
  return defineConnector({
    name: META_LEADS_CONNECTOR,
    label: {
      en: 'Facebook and Instagram lead ads',
      hi: 'Facebook और Instagram लीड विज्ञापन',
      te: 'Facebook మరియు Instagram లీడ్ ప్రకటనలు',
    },
    description: {
      en: 'Leads from the lead forms of your Facebook pages and their Instagram accounts.',
      hi: 'आपके Facebook पेजों और उनके Instagram खातों के लीड फ़ॉर्म से आए लीड।',
      te: 'మీ Facebook పేజీలు మరియు వాటి Instagram ఖాతాల లీడ్ ఫారమ్‌ల నుండి వచ్చే లీడ్‌లు.',
    },
    credentials: oauthCredentials,
    oauth: {
      authorizeUrl: `https://www.facebook.com/${v}/dialog/oauth`,
      tokenUrl: `https://graph.facebook.com/${v}/oauth/access_token`,
      apiUrl: `https://graph.facebook.com/${v}`,
      hosts: ['www.facebook.com', 'graph.facebook.com'],
      scopes: ['leads_retrieval', 'pages_show_list', 'pages_manage_metadata'],
      scopeSeparator: ',',
      // Meta's user tokens do not refresh; page tokens taken from a long-lived one do not expire.
      refresh: false,
      clientFrom: 'META_APP',
      /** The short-lived token, swapped for a long-lived one: the page tokens read with it last. */
      exchange: async (tokens, ctx): Promise<OAuthTokens> => {
        const url = new URL(ctx.endpoints.token);
        url.searchParams.set('grant_type', 'fb_exchange_token');
        url.searchParams.set('client_id', ctx.client.clientId);
        url.searchParams.set('client_secret', ctx.client.clientSecret);
        url.searchParams.set('fb_exchange_token', tokens.accessToken);
        const res = await ctx.http({
          method: 'GET',
          url: url.toString(),
          headers: { accept: 'application/json' },
        });
        if (res.status !== 200) throw oauthError(res.status, res.body, 'The long-lived exchange');
        const token = (res.body as { access_token?: unknown } | null)?.access_token;
        if (typeof token !== 'string' || !token) throw oauthError(502, null, 'No long-lived token');
        // Its 60 days are not tracked: the page tokens it gives do not expire, and a token Meta
        // stops accepting (error 190) marks the connection for signing in again.
        return { accessToken: token, ...(tokens.scopes ? { scopes: tokens.scopes } : {}) };
      },
      grantedScopes: async (tokens, ctx) => {
        const body = Permissions.parse(
          await graphGet(ctx, '/me/permissions', tokens.accessToken, 'Reading the permissions'),
        );
        return body.data.filter((p) => p.status === 'granted').map((p) => p.permission);
      },
      describe: async (tokens, ctx) => {
        const body = Pages.parse(
          await graphGet(
            ctx,
            '/me/accounts?fields=id,name,access_token&limit=100',
            tokens.accessToken,
            'Listing the pages',
          ),
        );
        return {
          accounts: body.data.map((p) => ({
            id: p.id,
            name: p.name,
            ...(p.access_token ? { token: p.access_token } : {}),
          })),
        };
      },
      pick: {
        /** The page sends its new leads to the app's webhook. */
        subscribe: async (account, call) => {
          const res = await call({
            method: 'POST',
            url: `/${encodeURIComponent(account.id)}/subscribed_apps?subscribed_fields=leadgen`,
            account: account.id,
          });
          if (res.status !== 200) throw oauthError(res.status, res.body, 'Subscribing the page');
        },
      },
      revoke: async (tokens, ctx) => {
        const res = await ctx.http({
          method: 'DELETE',
          url: ctx.api('/me/permissions'),
          headers: bearer(tokens.accessToken),
        });
        // Already withdrawn (190) counts as done.
        if (res.status !== 200 && !isTokenError(res))
          throw oauthError(res.status, res.body, 'Withdrawing the permissions');
      },
      isAuthError: isTokenError,
    },
    inbound: {
      // The lead id is in the signed body.
      signedIds: true,
      shared: {
        verify: (req, app) =>
          verifyHmac({
            secret: app.clientSecret,
            payload: req.rawBody,
            signature: readHeader(req.headers, 'x-hub-signature-256'),
            prefix: 'sha256=',
            algorithm: 'sha256',
            encoding: 'hex',
          }),
        parse: (req) =>
          noticesOf(req.body).map((n) => ({ id: n.leadId, type: LEADGEN_EVENT, data: n })),
        challenge: (req, app) => {
          const q = req.query;
          const expected = app.setting('VERIFY_TOKEN');
          if (q['hub.mode'] !== 'subscribe' || !expected) return null;
          if (q['hub.verify_token'] !== expected) return null;
          const challenge = q['hub.challenge'];
          return typeof challenge === 'string' && challenge.length <= 200 ? challenge : null;
        },
        accountOf: (event) => (event.data as MetaLeadNotice).pageId,
      },
      /** The notice, as the lead: its answers, read with the page's token. */
      expand: async (event, ctx) => {
        if (event.type !== LEADGEN_EVENT) return event;
        const notice = event.data as MetaLeadNotice;
        const res = await ctx.call({
          method: 'GET',
          url: `/${encodeURIComponent(notice.leadId)}?fields=created_time,field_data,form_id,ad_id`,
          account: notice.pageId,
        });
        if (res.status !== 200) throw oauthError(res.status, res.body, 'Fetching the lead');
        const lead = Lead.parse(res.body);
        const created = lead.created_time ? Date.parse(lead.created_time) : Number.NaN;
        const data: MetaLead = {
          leadId: lead.id,
          pageId: notice.pageId,
          form: lead.form_id ?? notice.form,
          ad: lead.ad_id ?? notice.ad,
          fields: (lead.field_data ?? []).map((f) => ({
            name: f.name,
            values: (f.values ?? []).map((x) => String(x)),
          })),
          createdAt: new Date(
            Number.isFinite(created)
              ? created
              : notice.createdTime
                ? notice.createdTime * 1000
                : Date.now(),
          ).toISOString(),
        };
        return { id: event.id, type: LEAD_EVENT, data };
      },
    },
  });
}
