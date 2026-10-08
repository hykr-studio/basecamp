import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  RemoteTemplate,
  StatusUpdate,
  TemplateSpec,
} from '../adapter.js';
import { RetryableError } from '../adapter.js';
import { graphError } from './errors.js';
import { Envelope, type WaMessage } from './schema.js';

export type WhatsAppConfig = {
  /** http://localhost:8080 for whaloc; https://graph.facebook.com for Meta. */
  graphUrl: string;
  apiVersion: string;
  accessToken: string;
  /** HMAC key for X-Hub-Signature-256. */
  appSecret: string;
  /** The WhatsApp Business Account: templates live here. */
  wabaId: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Give up on a call after this long: a stuck provider must not hold a worker. */
  timeoutMs?: number;
  log?: (message: string) => void;
};

/** WhatsApp's own limits, which the renderer respects. */
export const WHATSAPP_LIMITS = {
  maxButtons: 3,
  maxListRows: 10,
  maxTextLength: 4096,
  buttonTitle: 20,
  rowTitle: 24,
  rowDescription: 72,
  body: 1024,
} as const;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One outbound message as a Graph payload. */
export function toGraph(msg: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: msg.to };
  switch (msg.kind) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: false, body: msg.text } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: cut(msg.text, WHATSAPP_LIMITS.body) },
          action: {
            buttons: msg.buttons.slice(0, WHATSAPP_LIMITS.maxButtons).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: cut(b.title, WHATSAPP_LIMITS.buttonTitle) },
            })),
          },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: cut(msg.text, WHATSAPP_LIMITS.body) },
          action: {
            button: cut(msg.button, WHATSAPP_LIMITS.buttonTitle),
            sections: [
              {
                rows: msg.rows.slice(0, WHATSAPP_LIMITS.maxListRows).map((r) => ({
                  id: r.id,
                  title: cut(r.title, WHATSAPP_LIMITS.rowTitle),
                  ...(r.description
                    ? { description: cut(r.description, WHATSAPP_LIMITS.rowDescription) }
                    : {}),
                })),
              },
            ],
          },
        },
      };
    case 'template': {
      const components: Record<string, unknown>[] = [];
      const params = Object.entries(msg.params);
      if (params.length)
        components.push({
          type: 'body',
          parameters: params.map(([name, text]) => ({
            type: 'text',
            parameter_name: name,
            text,
          })),
        });
      for (const [index, b] of (msg.buttons ?? []).entries())
        components.push(
          'payload' in b
            ? {
                type: 'button',
                sub_type: 'quick_reply',
                index: String(index),
                parameters: [{ type: 'payload', payload: b.payload }],
              }
            : {
                type: 'button',
                sub_type: 'url',
                index: String(index),
                parameters: [{ type: 'text', text: b.urlParam }],
              },
        );
      return {
        ...base,
        type: 'template',
        template: { name: msg.name, language: { code: msg.language }, components },
      };
    }
  }
}

/** One webhook message, normalized; undefined for a type we don't handle. */
function toInbound(
  m: WaMessage,
  to: string,
  names: Map<string, string>,
): InboundMessage | undefined {
  const common = {
    providerMessageId: m.id,
    to,
    from: m.from,
    profileName: names.get(m.from),
    at: new Date(Number(m.timestamp) * 1000),
    replyTo: m.context?.id,
  };
  if (m.type === 'text' && m.text) return { ...common, body: { kind: 'text', text: m.text.body } };
  if (m.type === 'interactive' && m.interactive?.button_reply)
    return {
      ...common,
      body: {
        kind: 'button',
        payload: m.interactive.button_reply.id,
        text: m.interactive.button_reply.title,
      },
    };
  if (m.type === 'interactive' && m.interactive?.list_reply)
    return {
      ...common,
      body: {
        kind: 'list',
        rowId: m.interactive.list_reply.id,
        title: m.interactive.list_reply.title,
      },
    };
  if (m.type === 'button' && m.button)
    return { ...common, body: { kind: 'button', payload: m.button.payload, text: m.button.text } };
  if (m.type === 'audio' && m.audio)
    return { ...common, body: { kind: 'audio', mediaId: m.audio.id, mime: m.audio.mime_type } };
  const media = m.image ?? m.document ?? m.video;
  if (media)
    return {
      ...common,
      body: { kind: 'media', mediaId: media.id, mime: media.mime_type, caption: media.caption },
    };
  return undefined;
}

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * The WhatsApp Cloud API over plain fetch. Pointed at whaloc in development and CI, at Meta
 * elsewhere: only the Graph URL differs.
 */
export function createWhatsAppAdapter(cfg: WhatsAppConfig): ChannelAdapter {
  const http = cfg.fetch ?? fetch;
  const graph = (path: string) => `${cfg.graphUrl.replace(/\/$/, '')}/${cfg.apiVersion}/${path}`;
  const auth = { authorization: `Bearer ${cfg.accessToken}` };

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await http(graph(path), {
        ...init,
        headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
      });
    } catch (e) {
      // The network, not WhatsApp: worth another try.
      throw new RetryableError(`Graph unreachable: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) throw await graphError(res);
    return (await res.json()) as T;
  }

  return {
    channel: 'whatsapp',
    capabilities: {
      maxButtons: WHATSAPP_LIMITS.maxButtons,
      maxListRows: WHATSAPP_LIMITS.maxListRows,
      maxTextLength: WHATSAPP_LIMITS.maxTextLength,
      templates: true,
      media: true,
    },

    verify(rawBody, headers) {
      const header = headers['x-hub-signature-256'];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!cfg.appSecret || !signature?.startsWith('sha256=')) return false;
      const expected = createHmac('sha256', cfg.appSecret).update(rawBody).digest();
      const given = Buffer.from(signature.slice('sha256='.length), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    parse(body) {
      const messages: InboundMessage[] = [];
      const statuses: StatusUpdate[] = [];
      const skipped: string[] = [];
      const parsed = Envelope.safeParse(body);
      if (!parsed.success) return { messages, statuses, skipped: ['unreadable envelope'] };
      for (const entry of parsed.data.entry)
        for (const change of entry.changes) {
          const value = change.value;
          const to = value.metadata?.phone_number_id ?? '';
          const names = new Map(
            (value.contacts ?? []).flatMap((c) =>
              c.profile?.name ? [[c.wa_id, c.profile.name]] : [],
            ),
          ) as Map<string, string>;
          for (const m of value.messages ?? []) {
            const inbound = toInbound(m, to, names);
            if (inbound) messages.push(inbound);
            else skipped.push(`message type ${m.type}`);
          }
          for (const s of value.statuses ?? []) {
            if (!STATUSES.has(s.status)) {
              skipped.push(`status ${s.status}`);
              continue;
            }
            statuses.push({
              providerMessageId: s.id,
              status: s.status as StatusUpdate['status'],
              errorCode: s.errors?.[0]?.code,
              at: new Date(Number(s.timestamp) * 1000),
            });
          }
        }
      for (const reason of skipped) cfg.log?.(`whatsapp webhook: skipped ${reason}`);
      return { messages, statuses, skipped };
    },

    async send(from, msg) {
      const res = await call<{ messages: { id: string }[] }>(`${from}/messages`, {
        method: 'POST',
        body: JSON.stringify(toGraph(msg)),
      });
      const id = res.messages?.[0]?.id;
      if (!id) throw new RetryableError('Graph accepted the message but returned no id');
      return { providerMessageId: id };
    },

    async markRead(from, providerMessageId) {
      await call(`${from}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: providerMessageId,
        }),
      });
    },

    async downloadMedia(mediaId, phoneNumberId) {
      const meta = await call<{ url: string; mime_type: string }>(
        phoneNumberId ? `${mediaId}?phone_number_id=${encodeURIComponent(phoneNumberId)}` : mediaId,
      );
      const res = await http(meta.url, {
        headers: auth,
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
      });
      if (!res.ok) throw await graphError(res);
      return { bytes: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type };
    },

    templates: {
      async list() {
        const out: RemoteTemplate[] = [];
        let path: string | undefined = `${cfg.wabaId}/message_templates?limit=100`;
        while (path) {
          const page: {
            data: {
              id: string;
              name: string;
              language: string;
              status: string;
              category: string;
              rejected_reason?: string;
            }[];
            paging?: { next?: string; cursors?: { after?: string } };
          } = await call(path);
          for (const t of page.data)
            out.push({
              id: t.id,
              name: t.name,
              language: t.language,
              status: t.status,
              category: t.category,
              ...(t.rejected_reason && t.rejected_reason !== 'NONE'
                ? { rejectedReason: t.rejected_reason }
                : {}),
            });
          const after = page.paging?.next ? page.paging.cursors?.after : undefined;
          path = after ? `${cfg.wabaId}/message_templates?limit=100&after=${after}` : undefined;
        }
        return out;
      },
      async create(t: TemplateSpec) {
        const names = Object.keys(t.examples);
        const components: Record<string, unknown>[] = [
          {
            type: 'BODY',
            text: t.body,
            ...(names.length
              ? {
                  example: {
                    body_text_named_params: names.map((n) => ({
                      param_name: n,
                      example: t.examples[n],
                    })),
                  },
                }
              : {}),
          },
        ];
        if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
        if (t.buttons?.length)
          components.push({
            type: 'BUTTONS',
            buttons: t.buttons.map((b) =>
              b.type === 'QUICK_REPLY'
                ? { type: 'QUICK_REPLY', text: b.text }
                : {
                    type: 'URL',
                    text: b.text,
                    url: b.url,
                    ...(b.example ? { example: [b.example] } : {}),
                  },
            ),
          });
        const res = await call<{ id: string }>(`${cfg.wabaId}/message_templates`, {
          method: 'POST',
          body: JSON.stringify({
            name: t.name,
            language: t.language,
            category: t.category,
            parameter_format: 'NAMED',
            components,
          }),
        });
        return { id: res.id };
      },
    },
  };
}
