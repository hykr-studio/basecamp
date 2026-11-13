// The application's languages (docs/decisions/HLANG.md), end to end on a fixture that also
// speaks Greek, a language the framework has no phrases for: WhatsApp knows a Greek message by
// its letters, keeps the contact in Greek, matches the application's Greek keywords and answers
// in the application's Greek words, else in English. Inputs in a language the application does
// not speak are refused, a voice session carries the set to the worker, and a business words
// phrases and roles only in the application's languages.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { t } from '@hykr/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, eventually, me, Person, pool, server, shutdown } from '../../dist/testing.js';
import {
  GREEK_STOPPED,
  languagesApp,
  languagesWithGreek,
} from '../fixture/dist/features/languages/index.js';

type Sent = { body: { to: string; type?: string; text?: { body: string } } };
const sent: Sent[] = [];
const textsTo = (n: string) =>
  sent.filter((s) => s.body.to === n && s.body.type === 'text').map((s) => s.body.text?.body);
let stub: Server;
const secret = 'test-app-secret';
const NUMBER = `pn-lang-${Date.now()}`;
const ana = new Person('Ana Languages');
const kiran = new Person('Kiran Languages');

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push({ body: JSON.parse(data) });
      const id = `wamid.${Date.now()}.${sent.length}`;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id }], success: true }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = secret;
  process.env.WA_VERIFY_TOKEN = 'test-verify';
  await boot(languagesApp);
  await ana.signUp();
  await kiran.signUp();
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

let seq = 0;
const deliver = async (from: string, body: string) => {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: NUMBER },
              messages: [
                {
                  from,
                  id: `m-lang-${Date.now()}-${seq++}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await fetch(`${server.base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  expect(res.status).toBe(200);
};
const localeOf = async (address: string) =>
  (
    await pool.query(
      `select c.locale from channel.contacts c join channel.numbers n on n.tenant_id = c.tenant_id
       where n.phone_number_id = $1 and c.address = $2`,
      [NUMBER, address],
    )
  ).rows[0]?.locale;

describe('WhatsApp in a language the application declares', () => {
  const greek = `3069${String(Date.now()).slice(-8)}`;

  it("knows a Greek message by its letters, keeps the contact in Greek, and stops on the application's Greek keyword", async () => {
    await deliver(greek, 'Σταμάτα!');
    const replies = await eventually(() =>
      textsTo(greek).length >= 2 ? textsTo(greek) : undefined,
    );
    // The welcome has no Greek words: it reads in English. The stop has the application's.
    expect(replies[0]).toContain('privacy notice');
    expect(replies[1]).toBe(GREEK_STOPPED);
    expect(await localeOf(greek)).toBe('el');
  });

  it('answers in English where the application gave no Greek words', async () => {
    await deliver(greek, 'βοήθεια');
    const [help] = await eventually(() =>
      textsTo(greek).length >= 3 ? textsTo(greek).slice(2) : undefined,
    );
    expect(help?.startsWith(t('en', 'channel.does'))).toBe(true);
    expect(await localeOf(greek)).toBe('el');
  });

  it('the framework’s own translations still answer the languages it has them for', async () => {
    const hindi = `9197${String(Date.now()).slice(-8)}`;
    await deliver(hindi, 'रोकें');
    const replies = await eventually(() =>
      textsTo(hindi).length >= 2 ? textsTo(hindi) : undefined,
    );
    expect(replies[1]).toBe(t('hi', 'channel.stopped'));
    expect(await localeOf(hindi)).toBe('hi');
  });
});

describe('inputs in a language', () => {
  it('a chat turn may be in a declared language, never in another', async () => {
    const turn = await ana.call('POST', '/api/chat/once', { message: 'hello', lang: 'el' });
    expect(turn.status).toBeLessThan(300);
    const refused = await ana.call('POST', '/api/chat/once', { message: 'hello', lang: 'fr' });
    expect(refused.status).toBe(400);
    const thread = (await ana.call('GET', '/api/threads/current')).body;
    const messages = (await ana.call('GET', `/api/threads/${thread.id}/messages`)).body;
    expect(messages.map((m: { metadata: { lang: string } }) => m.metadata.lang)).toContain('el');
    // Another person's thread, its languages with it, is not there for them.
    expect((await kiran.call('GET', `/api/threads/${thread.id}/messages`)).status).toBe(404);
  });

  it('a business words phrases and names roles only in the application’s languages', async () => {
    const greekPhrase = await ana.call('PATCH', '/api/settings/wording', {
      phrases: { 'channel.started': { el: 'Οι υπενθυμίσεις ξεκίνησαν ξανά.' } },
    });
    expect(greekPhrase.status).toBe(200);
    const french = await ana.call('PATCH', '/api/settings/wording', {
      phrases: { 'channel.started': { fr: 'Les rappels reprennent.' } },
    });
    expect(french.status).toBe(400);
    const role = await ana.call('POST', '/api/members/roles', {
      name: 'greeter',
      label: { en: 'Greeter', el: 'Υποδοχή' },
      capabilities: [],
    });
    expect(role.status).toBe(200);
    const roles = (await ana.call('GET', '/api/members/roles')).body;
    expect(JSON.stringify(roles)).toContain('Υποδοχή');
    const frenchRole = await ana.call('POST', '/api/members/roles', {
      name: 'accueil',
      label: { en: 'Welcome desk', fr: 'Accueil' },
      capabilities: [],
    });
    expect(frenchRole.status).toBe(400);
    // Kiran's business has neither.
    expect(JSON.stringify((await kiran.call('GET', '/api/members/roles')).body)).not.toContain(
      'Υποδοχή',
    );
    expect((await me(kiran)).tenantId).not.toBe((await me(ana)).tenantId);
  });
});

describe('a voice session', () => {
  it.skipIf(!process.env.VOICE_AGENT_KEY)(
    'may be pinned to a declared language, and carries the set to the worker',
    async () => {
      const { TokenVerifier } = await import('livekit-server-sdk');
      const res = await ana.call('POST', '/api/voice/session', { lang: 'el' });
      expect(res.status).toBe(201);
      const claims = await new TokenVerifier(
        process.env.LIVEKIT_API_KEY ?? 'devkey',
        process.env.LIVEKIT_API_SECRET ?? 'secret',
      ).verify(res.body.token);
      const dispatch = JSON.parse(claims.roomConfig?.agents?.[0]?.metadata ?? '{}');
      expect(dispatch.lang).toBe('el');
      expect(dispatch.languages).toEqual(JSON.parse(JSON.stringify(languagesWithGreek.toWire())));
      const el = dispatch.languages.find((l: { code: string }) => l.code === 'el');
      expect(el).toMatchObject({ english: 'Greek', speech: 'el-GR' });
      // Its letters travel as a pattern the worker compiles.
      expect(new RegExp(el.letters.source, el.letters.flags).test('γ')).toBe(true);
      expect((await ana.call('POST', '/api/voice/session', { lang: 'fr' })).status).toBe(400);
    },
  );
});
