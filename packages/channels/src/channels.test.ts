import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermanentError, RetryableError } from './adapter.js';
import { signApproval, verifyApproval } from './approval-token.js';
import { keywordOf } from './keywords.js';
import { render } from './render.js';
import { split } from './split.js';
import { createWhatsAppAdapter, toGraph } from './whatsapp/adapter.js';

const secret = 'test-app-secret';
const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** A Graph stand-in: records requests, answers with a status and body. */
function stubFetch(status = 200, body: unknown = { messages: [{ id: 'wamid.1' }] }, headers = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const adapter = (f = stubFetch()) =>
  createWhatsAppAdapter({
    graphUrl: 'http://graph.test',
    apiVersion: 'v25.0',
    accessToken: 't',
    appSecret: secret,
    wabaId: 'waba1',
    fetch: f.fn,
  });

const webhook = (messages: unknown[], statuses: unknown[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pn1' },
            contacts: [{ wa_id: '919000000001', profile: { name: 'Asha' } }],
            messages,
            statuses,
          },
        },
      ],
    },
  ],
});

describe('the WhatsApp adapter', () => {
  it('verifies the signature over the exact bytes', () => {
    const body = JSON.stringify(webhook([]));
    const wa = adapter();
    expect(wa.verify(Buffer.from(body), { 'x-hub-signature-256': sign(body) })).toBe(true);
    expect(wa.verify(Buffer.from(`${body} `), { 'x-hub-signature-256': sign(body) })).toBe(false);
    expect(wa.verify(Buffer.from(body), {})).toBe(false);
  });

  it('parses text, buttons, list replies, voice notes and statuses; skips the rest', () => {
    const parsed = adapter().parse(
      webhook(
        [
          {
            from: '919000000001',
            id: 'm1',
            timestamp: '1790000000',
            type: 'text',
            text: { body: 'hi' },
          },
          {
            from: '919000000001',
            id: 'm2',
            timestamp: '1790000001',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'apr:x', title: 'Approve' } },
          },
          {
            from: '919000000001',
            id: 'm3',
            timestamp: '1790000002',
            type: 'interactive',
            interactive: { type: 'list_reply', list_reply: { id: 'pick:9', title: 'Site visit' } },
          },
          {
            from: '919000000001',
            id: 'm4',
            timestamp: '1790000003',
            type: 'audio',
            audio: { id: 'media1', mime_type: 'audio/ogg' },
          },
          { from: '919000000001', id: 'm5', timestamp: '1790000004', type: 'location' },
        ],
        [{ id: 'wamid.9', status: 'failed', timestamp: '1790000005', errors: [{ code: 131026 }] }],
      ),
    );
    expect(parsed.messages.map((m) => [m.providerMessageId, m.body.kind])).toEqual([
      ['m1', 'text'],
      ['m2', 'button'],
      ['m3', 'list'],
      ['m4', 'audio'],
    ]);
    expect(parsed.messages[0]).toMatchObject({
      to: 'pn1',
      from: '919000000001',
      profileName: 'Asha',
    });
    expect(parsed.statuses).toEqual([
      expect.objectContaining({
        providerMessageId: 'wamid.9',
        status: 'failed',
        errorCode: 131026,
      }),
    ]);
    expect(parsed.skipped).toEqual(['message type location']);
    expect(adapter().parse({ nonsense: true }).skipped).toEqual(['unreadable envelope']);
  });

  it('sends Graph payloads: text, buttons, lists, templates with named parameters', async () => {
    const f = stubFetch();
    await adapter(f).send('pn1', {
      kind: 'template',
      to: '919',
      name: 'meeting_reminder_v1',
      language: 'te',
      params: { title: 'Site visit', time: '4:30 pm' },
      buttons: [{ payload: 'ntf:snooze' }, { urlParam: 'abc' }],
    });
    expect(f.calls[0].url).toBe('http://graph.test/v25.0/pn1/messages');
    expect(f.calls[0].body).toMatchObject({
      type: 'template',
      template: {
        name: 'meeting_reminder_v1',
        language: { code: 'te' },
        components: [
          {
            type: 'body',
            parameters: [
              { parameter_name: 'title', text: 'Site visit' },
              { parameter_name: 'time', text: '4:30 pm' },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'ntf:snooze' }],
          },
          { type: 'button', sub_type: 'url', index: '1' },
        ],
      },
    });
    const buttons = toGraph({
      kind: 'buttons',
      to: '919',
      text: 'Delete it?',
      buttons: [{ id: 'a', title: 'A button title that is far too long' }],
    });
    expect(buttons).toMatchObject({
      interactive: { type: 'button', action: { buttons: [{ reply: { id: 'a' } }] } },
    });
    expect(
      (buttons as { interactive: { action: { buttons: { reply: { title: string } }[] } } })
        .interactive.action.buttons[0].reply.title.length,
    ).toBeLessThanOrEqual(20);
  });

  it('retries 429, 5xx and throughput limits; never a permanent error', async () => {
    const rate = adapter(
      stubFetch(429, { error: { code: 130429, message: 'slow down' } }, { 'retry-after': '3' }),
    );
    await expect(rate.send('pn1', { kind: 'text', to: '9', text: 'x' })).rejects.toMatchObject({
      constructor: RetryableError,
      retryAfterMs: 3000,
    });
    const down = adapter(stubFetch(503, 'oops'));
    await expect(down.send('pn1', { kind: 'text', to: '9', text: 'x' })).rejects.toBeInstanceOf(
      RetryableError,
    );
    const invalid = adapter(
      stubFetch(400, { error: { code: 131026, message: 'not on WhatsApp' } }),
    );
    await expect(invalid.send('pn1', { kind: 'text', to: '9', text: 'x' })).rejects.toMatchObject({
      constructor: PermanentError,
      code: 131026,
    });
  });
});

describe('render', () => {
  const o = { to: '919', lang: 'en' as const, appUrl: 'http://app' };
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));

  it('words first, then 2–3 rows as buttons, 4–10 as a list, more as a list plus a link', () => {
    expect(
      render(
        { reply: 'Here.', views: [{ text: 'To-dos\n• a\n• b', choices: rows(2) }], approvals: [] },
        o,
      ),
    ).toEqual([
      { kind: 'text', to: '919', text: 'Here.' },
      {
        kind: 'buttons',
        to: '919',
        text: 'To-dos',
        buttons: [
          { id: 'pick:r0', title: 'Row 0' },
          { id: 'pick:r1', title: 'Row 1' },
        ],
      },
    ]);
    const list = render(
      { reply: '', views: [{ text: 'Meetings', choices: rows(7) }], approvals: [] },
      o,
    );
    expect(list).toEqual([
      expect.objectContaining({ kind: 'list', button: 'Choose', rows: expect.any(Array) }),
    ]);
    const many = render(
      { reply: 'Lots.', views: [{ text: 'Meetings', choices: rows(14) }], approvals: [] },
      o,
    );
    expect(many[0]).toMatchObject({ kind: 'text', text: 'Lots.\n\nMore in the app: http://app' });
    expect((many[1] as { rows: unknown[] }).rows).toHaveLength(10);
  });

  it('a view with no rows to pick is just words', () => {
    expect(render({ reply: 'Done.', views: [{ text: '• one to-do' }], approvals: [] }, o)).toEqual([
      { kind: 'text', to: '919', text: 'Done.\n\n• one to-do' },
    ]);
  });

  it('an approval gets Approve and Reject, in the language; without buttons, a link', () => {
    const turn = {
      reply: 'It waits.',
      views: [],
      approvals: [{ id: 'ap1', summary: 'Delete "Tiles"' }],
    };
    const withButtons = render(turn, {
      ...o,
      lang: 'hi',
      approvalButtons: () => ({ approve: 'apr:a', reject: 'apr:r' }),
    });
    expect(withButtons[1]).toEqual({
      kind: 'buttons',
      to: '919',
      text: 'Delete "Tiles"',
      buttons: [
        { id: 'apr:a', title: 'मंज़ूर करें' },
        { id: 'apr:r', title: 'अस्वीकार करें' },
      ],
    });
    expect(render(turn, o)[0]).toMatchObject({
      text: expect.stringContaining('Approve it in the app: http://app/approvals'),
    });
  });

  it('long words split on paragraph breaks within the limit', () => {
    const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    expect(split(text, 4096)).toEqual(['a'.repeat(3000), 'b'.repeat(3000)]);
    expect(split('x'.repeat(5000), 4096).map((c) => c.length)).toEqual([4096, 904]);
  });
});

describe('keywords', () => {
  it('a whole message in any language, any case; not a sentence that mentions one', () => {
    expect(keywordOf('STOP')).toBe('stop');
    expect(keywordOf(' Stop! ')).toBe('stop');
    expect(keywordOf('रोकें')).toBe('stop');
    expect(keywordOf('ఆపు')).toBe('stop');
    expect(keywordOf('stop reminders')).toBe('stop_reminders');
    expect(keywordOf('talk to a person')).toBe('human');
    expect(keywordOf('నా డేటా తొలగించు')).toBe('delete_my_data');
    expect(keywordOf('please stop the meeting at 4')).toBeUndefined();
  });
});

describe('approval buttons', () => {
  const d = { approvalId: 'ap1', approve: true, expiresAt: 2_000 };
  it('decide once, before they expire, only for the contact they were sent to', () => {
    const payload = signApproval('k', d, 'contact1');
    expect(verifyApproval('k', payload, 'contact1', 1_000)).toEqual({ ok: true, decision: d });
    expect(verifyApproval('k', payload, 'contact1', 3_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyApproval('k', payload, 'someone-else', 1_000)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyApproval('k', payload.replace(':a:', ':r:'), 'contact1', 1_000)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyApproval('other-key', payload, 'contact1', 1_000)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
