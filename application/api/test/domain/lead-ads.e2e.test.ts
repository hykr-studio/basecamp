// The briefs module and Facebook and Instagram lead ads (B24): the owner connects the business by
// signing in with Facebook (the fake provider stands in for Meta), picks the studio's page, and
// each lead sent from one of its lead forms arrives at the app's one webhook URL, is fetched once
// with the page's token and becomes a brief, `source: 'lead_ad'`, as the business's system.
import { createHmac, randomUUID } from 'node:crypto';
import {
  boot,
  connectOAuth,
  eventually,
  type FakeOAuthProvider,
  fakeOAuthProvider,
  type Json,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.INTEGRATIONS_ALLOWED_HOSTS = '127.0.0.1';

const owner = new Person('Owner Lead Ads');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

let fake: FakeOAuthProvider;
const saved = { ...process.env };
const run = randomUUID().slice(0, 8);
const PAGE = `studio-page-${run}`;
const LEAD = `lead-${run}`;

const notice = (leadId: string) => ({
  object: 'page',
  entry: [
    {
      id: PAGE,
      time: 1,
      changes: [
        {
          field: 'leadgen',
          value: { leadgen_id: leadId, page_id: PAGE, form_id: 'kitchen-form', created_time: 1 },
        },
      ],
    },
  ],
});

const post = (payload: object) => {
  const raw = JSON.stringify(payload);
  return fetch(`${server.base}/webhooks/meta-leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'fake-meta-app-secret').update(raw).digest('hex')}`,
    },
    body: raw,
  });
};

beforeAll(async () => {
  fake = await fakeOAuthProvider();
  Object.assign(process.env, fake.env('META_APP', { meta: true }));
  await boot(application);
  process.env.INTEGRATIONS_OAUTH_REDIRECT_URL = `${server.base}/api/integrations/oauth/callback`;
  await owner.signUp();
  tenantId = (await me(owner)).tenantId;
});

afterAll(async () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  await shutdown();
  await fake.close();
});

describe('lead ads become briefs', () => {
  it('connects the studio’s page by signing in with Facebook', async () => {
    fake.pages = [{ id: PAGE, name: 'Studio Interiors' }];
    const out = await connectOAuth(owner, 'meta-leads', inTenant());
    expect(out.status).toBe(201);
    const id = out.body.value.id;
    const picked = await owner.call(
      'POST',
      `/api/integrations/connections/${id}/oauth/pick`,
      { accountIds: [PAGE] },
      inTenant(),
    );
    expect(picked.status).toBe(200);
    expect(picked.body.subscribed).toEqual([{ id: PAGE, ok: true }]);
  });

  it('a lead from its form is a new brief, once', async () => {
    fake.leads.set(LEAD, {
      id: LEAD,
      pageId: PAGE,
      formId: 'kitchen-form',
      adId: 'ad-1',
      createdTime: '2026-11-18T10:00:00+0000',
      fields: [
        { name: 'full_name', values: ['Asha Rao'] },
        { name: 'phone_number', values: ['+919800000001'] },
        { name: 'what_do_you_need', values: ['A modular kitchen'] },
        { name: 'city', values: ['Hyderabad'] },
      ],
    });
    expect((await post(notice(LEAD))).status).toBe(200);
    const brief = await eventually(async () => {
      const res = await owner.call('GET', '/api/briefs?source=lead_ad', undefined, inTenant());
      return res.body.items?.find((b: Json) => b.notes.includes(LEAD));
    });
    expect(brief).toMatchObject({
      name: 'Asha Rao',
      phone: '+919800000001',
      source: 'lead_ad',
      status: 'new',
      summary: 'what do you need: A modular kitchen\ncity: Hyderabad',
    });
    // Meta sends it again: the same stored event, fetched and written once.
    expect((await post(notice(LEAD))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(fake.count(`/graph/${LEAD}`, 'GET')).toBe(1);
    const { rows } = await pool.query(
      `select count(*)::int as n from app.briefs where tenant_id = $1 and notes like $2`,
      [tenantId, `%${LEAD}%`],
    );
    expect(rows[0].n).toBe(1);
  });
});
