import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bodyKey, checkEvent, defineConnector, type InboundRequest } from './connector.js';
import { googleCalendarConnector } from './google-calendar/connector.js';
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

  it('refuses a sender with no body unless its ids are signed', () => {
    const base = { name: 'push-only', label, credentials: standardWebhooks.credentials };
    const inbound = { bodyless: true, verify: () => true, parse: () => [] };
    expect(() => defineConnector({ ...base, inbound })).toThrow('signedIds');
    expect(defineConnector({ ...base, inbound: { ...inbound, signedIds: true } }).name).toBe(
      'push-only',
    );
  });

  it('keys an event by a hash of the exact body, and its place in a batch', () => {
    const raw = Buffer.from('{"a":1}');
    const hex = createHash('sha256').update(raw).digest('hex');
    expect(bodyKey(raw)).toBe(`sha256:${hex}`);
    expect(bodyKey('{"a":1}')).toBe(`sha256:${hex}`);
    expect(bodyKey(raw, 2)).toBe(`sha256:${hex}:2`);
    expect(bodyKey(Buffer.from('{"a":1} '))).not.toBe(bodyKey(raw));
    expect(checkEvent({ id: bodyKey(raw, 199), type: 't', data: null }).id).toBe(
      `sha256:${hex}:199`,
    );
  });

  it('the built-in connectors declare their ids signed', () => {
    expect(standardWebhooks.inbound?.signedIds).toBe(true);
    expect(googleCalendarConnector.inbound?.signedIds).toBe(true);
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

  it('does not vouch for an id header its signature leaves out', () => {
    const body = { type: 'thing.done', n: 1 };
    const raw = JSON.stringify(body);
    const req = request(body, { 'x-signature': sign(raw), 'x-event-id': 'ev-1' });
    // The same signature verifies under any id: the server must key this event by its body.
    const replay = { ...req, headers: { ...req.headers, 'x-event-id': 'ev-attacker-2' } };
    expect(sender.inbound?.verify(replay, creds)).toBe(true);
    expect(sender.inbound?.signedIds).toBe(false);
  });

  it('names an event by a hash of its body without an id, and "event" without a type', () => {
    const req = request({ n: 2 });
    const [event] = sender.inbound?.parse(req, creds) ?? [];
    expect(event.id).toBe(bodyKey(req.rawBody));
    expect(event.id).toBe(`sha256:${createHash('sha256').update(req.rawBody).digest('hex')}`);
    expect(event.type).toBe('event');
  });

  it('vouches for its ids when they are its own hash of the body', () => {
    const own = hmacConnector({ name: 'own-ids', label, header: 'x-sig' });
    expect(own.inbound?.signedIds).toBe(true);
    const fromBody = hmacConnector({
      name: 'body-ids',
      label,
      header: 'x-sig',
      eventId: (req) => (req.body as { id?: string }).id,
    });
    expect(fromBody.inbound?.signedIds).toBe(false);
    const declared = hmacConnector({
      name: 'body-ids-signed',
      label,
      header: 'x-sig',
      eventId: (req) => (req.body as { id?: string }).id,
      signedIds: true,
    });
    expect(declared.inbound?.signedIds).toBe(true);
  });

  describe('a sender that signs its id and a timestamp', () => {
    const signer = hmacConnector({
      name: 'signs-all',
      label,
      header: 'x-signature',
      prefix: 'v1=',
      idHeader: 'x-event-id',
      timestampHeader: 'x-timestamp',
      signedIds: true,
      signedContent: (req, { id, timestamp }) => `${timestamp}.${id}.${req.rawBody}`,
    });
    const c = { secret: 'y'.repeat(32) };
    const now = Date.UTC(2026, 10, 8, 12, 0, 0);
    const seconds = Math.floor(now / 1000);
    const body = { type: 'thing.done', n: 3 };
    const raw = JSON.stringify(body);
    const signedRequest = (id: string, ts: number | string, sigId = id, sigTs = ts) =>
      request(body, {
        'x-event-id': id,
        'x-timestamp': String(ts),
        'x-signature': `v1=${createHmac('sha256', c.secret).update(`${sigTs}.${sigId}.${raw}`).digest('hex')}`,
      });

    it('verifies a fresh request and reads its signed id', () => {
      const req = signedRequest('ev-1', seconds);
      expect(signer.inbound?.signedIds).toBe(true);
      expect(signer.inbound?.verify(req, c, now)).toBe(true);
      expect(signer.inbound?.verify(signedRequest('ev-1', seconds - 300), c, now)).toBe(true);
      expect(signer.inbound?.parse(req, c)).toEqual([
        { id: 'ev-1', type: 'thing.done', data: body },
      ]);
    });

    it('refuses the signature under a fresh id or another timestamp', () => {
      expect(signer.inbound?.verify(signedRequest('ev-2', seconds, 'ev-1'), c, now)).toBe(false);
      expect(
        signer.inbound?.verify(signedRequest('ev-1', seconds + 1, 'ev-1', seconds), c, now),
      ).toBe(false);
    });

    it('refuses a stale, a future, a missing or an unreadable timestamp, and a missing id', () => {
      expect(signer.inbound?.verify(signedRequest('ev-1', seconds - 301), c, now)).toBe(false);
      expect(signer.inbound?.verify(signedRequest('ev-1', seconds + 301), c, now)).toBe(false);
      expect(signer.inbound?.verify(signedRequest('ev-1', '12.5'), c, now)).toBe(false);
      const fresh = signedRequest('ev-1', seconds);
      const { 'x-timestamp': _t, ...noTimestamp } = fresh.headers as Record<string, string>;
      expect(signer.inbound?.verify({ ...fresh, headers: noTimestamp }, c, now)).toBe(false);
      const { 'x-event-id': _i, ...noId } = fresh.headers as Record<string, string>;
      expect(signer.inbound?.verify({ ...fresh, headers: noId }, c, now)).toBe(false);
    });

    it('reads milliseconds when told, with its own tolerance', () => {
      const ms = hmacConnector({
        name: 'signs-ms',
        label,
        header: 'x-signature',
        prefix: 'v1=',
        idHeader: 'x-event-id',
        timestampHeader: 'x-timestamp',
        timestampUnit: 'ms',
        toleranceSec: 60,
        signedIds: true,
        signedContent: (req, { id, timestamp }) => `${timestamp}.${id}.${req.rawBody}`,
      });
      expect(ms.inbound?.verify(signedRequest('ev-1', now - 60_000), c, now)).toBe(true);
      expect(ms.inbound?.verify(signedRequest('ev-1', now - 61_000), c, now)).toBe(false);
      expect(ms.inbound?.verify(signedRequest('ev-1', seconds), c, now)).toBe(false);
    });

    it('refuses a request its signedContent cannot build', () => {
      const broken = hmacConnector({
        name: 'signs-broken',
        label,
        header: 'x-signature',
        timestampHeader: 'x-timestamp',
        signedContent: () => {
          throw new Error('unreadable');
        },
      });
      expect(broken.inbound?.verify(signedRequest('ev-1', seconds), c, now)).toBe(false);
    });
  });

  it('refuses options that cannot be safe', () => {
    const base = { label, header: 'x-sig' };
    expect(() => hmacConnector({ ...base, name: 'a', timestampHeader: 'x-ts' })).toThrow(
      'signedContent',
    );
    expect(() => hmacConnector({ ...base, name: 'b', idHeader: 'x-id', signedIds: true })).toThrow(
      'id header',
    );
    const content = (req: InboundRequest) => req.rawBody;
    expect(() =>
      hmacConnector({ ...base, name: 'c', toleranceSec: 0, signedContent: content }),
    ).toThrow('toleranceSec');
    expect(() =>
      hmacConnector({ ...base, name: 'd', toleranceSec: 1.5, signedContent: content }),
    ).toThrow('toleranceSec');
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
