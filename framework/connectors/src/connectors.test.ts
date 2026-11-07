import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkEvent, defineConnector, type InboundRequest } from './connector.js';
import { hmacConnector } from './hmac-connector.js';
import { signWebhook } from './signature.js';
import { standardWebhooks } from './standard-webhooks.js';

const label = { en: 'Test sender', hi: 'परीक्षण प्रेषक', te: 'పరీక్ష పంపేవారు' };

const request = (body: unknown, headers: Record<string, string> = {}): InboundRequest => ({
  rawBody: Buffer.from(JSON.stringify(body)),
  headers,
  body,
  query: {},
});

describe('defineConnector', () => {
  it('checks the name and the public fields', () => {
    const base = { label, credentials: standardWebhooks.credentials };
    expect(() => defineConnector({ ...base, name: 'Bad Name' })).toThrow('lower case');
    expect(() => defineConnector({ ...base, name: 'ok', publicFields: ['a-b' as never] })).toThrow(
      'not a field name',
    );
    expect(defineConnector({ ...base, name: 'ok-2' }).name).toBe('ok-2');
  });

  it('bounds event ids and types', () => {
    expect(checkEvent({ id: 'e1', type: 't', data: undefined })).toEqual({
      id: 'e1',
      type: 't',
      data: null,
    });
    expect(() => checkEvent({ id: '', type: 't', data: null })).toThrow('id');
    expect(() => checkEvent({ id: 'x'.repeat(201), type: 't', data: null })).toThrow('id');
    expect(() => checkEvent({ id: 'a\nb', type: 't', data: null })).toThrow('id');
    expect(() => checkEvent({ id: 'a', type: 1 as never, data: null })).toThrow('type');
  });
});

describe('the standard-webhooks connector', () => {
  const creds = standardWebhooks.generate?.() as { secret: string };

  it('generates a whsec_ secret its schema accepts', () => {
    expect(creds.secret.startsWith('whsec_')).toBe(true);
    expect(standardWebhooks.credentials.safeParse(creds).success).toBe(true);
    expect(standardWebhooks.credentials.safeParse({ secret: 'short' }).success).toBe(false);
  });

  it('verifies a signed request and reads its one event', () => {
    const body = { type: 'record.paid', data: { ref: 'A-1' } };
    const raw = JSON.stringify(body);
    const headers = signWebhook({ secrets: [creds.secret], id: 'msg_9', body: raw });
    const req = { ...request(body, headers), rawBody: Buffer.from(raw) };
    expect(standardWebhooks.inbound?.verify(req, creds)).toBe(true);
    expect(standardWebhooks.inbound?.parse(req, creds)).toEqual([
      { id: 'msg_9', type: 'record.paid', data: { ref: 'A-1' } },
    ]);
  });

  it('refuses another secret, a stale request and a body without a type', () => {
    const raw = '{"type":"x"}';
    const old = Math.floor(Date.now() / 1000) - 3600;
    const stale = signWebhook({ secrets: [creds.secret], id: 'm', timestamp: old, body: raw });
    const req = { ...request({ type: 'x' }, stale), rawBody: Buffer.from(raw) };
    expect(standardWebhooks.inbound?.verify(req, creds)).toBe(false);
    const fresh = signWebhook({ secrets: [creds.secret], id: 'm', body: raw });
    const other = { secret: 'whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA==' };
    expect(standardWebhooks.inbound?.verify({ ...req, headers: fresh }, other)).toBe(false);
    expect(() => standardWebhooks.inbound?.parse(request({ data: 1 }), creds)).toThrow();
  });
});

describe('hmacConnector', () => {
  const sender = hmacConnector({
    name: 'test-sender',
    label,
    header: 'X-Signature',
    prefix: 'sha256=',
    idHeader: 'x-event-id',
  });
  const creds = sender.generate?.() as { secret: string };
  const sign = (raw: string) =>
    `sha256=${createHmac('sha256', creds.secret).update(raw).digest('hex')}`;

  it('verifies the header over the raw body', () => {
    const body = { type: 'thing.done', n: 1 };
    const raw = JSON.stringify(body);
    const req = request(body, { 'x-signature': sign(raw), 'x-event-id': 'ev-1' });
    expect(sender.inbound?.verify(req, creds)).toBe(true);
    expect(sender.inbound?.verify({ ...req, rawBody: Buffer.from(`${raw} `) }, creds)).toBe(false);
    expect(sender.inbound?.verify({ ...req, headers: {} }, creds)).toBe(false);
    expect(sender.inbound?.parse(req, creds)).toEqual([
      { id: 'ev-1', type: 'thing.done', data: body },
    ]);
  });

  it('names an event by a hash of its body without an id, and "event" without a type', () => {
    const req = request({ n: 2 });
    const [event] = sender.inbound?.parse(req, creds) ?? [];
    expect(event.id).toBe(createHash('sha256').update(req.rawBody).digest('hex'));
    expect(event.type).toBe('event');
  });

  it('reads several events when the sender batches them', () => {
    const batch = hmacConnector({
      name: 'batch-sender',
      label,
      header: 'x-sig',
      encoding: 'base64',
      events: (req) =>
        (req.body as { items: { id: string }[] }).items.map((i) => ({
          id: i.id,
          type: 'item',
          data: i,
        })),
    });
    const body = { items: [{ id: 'a' }, { id: 'b' }] };
    const raw = JSON.stringify(body);
    const c = { secret: 'x'.repeat(32) };
    const req = request(body, {
      'x-sig': createHmac('sha256', c.secret).update(raw).digest('base64'),
    });
    expect(batch.inbound?.verify(req, c)).toBe(true);
    expect(batch.inbound?.parse(req, c).map((e) => e.id)).toEqual(['a', 'b']);
  });
});
