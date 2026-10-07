import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@app/contracts';
import { type Database, schema } from '@app/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB } from '../../infra/db.module.js';
import { ChatService } from '../chat/chat.service.js';

const { channelLinks } = schema;
const log = new Logger('WhatsApp');

/** The parts of a Cloud API webhook we read: text messages, and the number they came to. */
type Webhook = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: { from?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
};

/** WhatsApp ids are digits only: "+91 98765-43210" and "919876543210" are the same person. */
export const toWaId = (phone: string) => phone.replace(/\D/g, '');

/**
 * The assistant on WhatsApp: a channel without a screen. Each message runs the same agent,
 * acting for the person the number is linked to, with surfaces ['text']: no canvas tools,
 * and every view a tool would show comes back rendered to words by the server.
 */
@Injectable()
export class WhatsappService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly chat: ChatService,
  ) {}

  /** Meta signs each delivery with the app secret: X-Hub-Signature-256: sha256=<hex>. */
  verifySignature(raw: Buffer | undefined, header: string | undefined): boolean {
    if (!raw || !header?.startsWith('sha256=') || !config.whatsapp.appSecret) return false;
    const expected = createHmac('sha256', config.whatsapp.appSecret).update(raw).digest();
    const given = Buffer.from(header.slice('sha256='.length), 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Every text message in a delivery gets one reply. Errors are logged, never retried here. */
  async handle(payload: Webhook) {
    const jobs: Promise<void>[] = [];
    for (const entry of payload.entry ?? [])
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        for (const m of change.value?.messages ?? []) {
          if (m.type !== 'text' || !m.from || !m.text?.body || !phoneNumberId) continue;
          jobs.push(
            this.reply(phoneNumberId, m.from, m.text.body).catch((e) =>
              log.error(`reply to ${m.from} failed: ${e instanceof Error ? e.message : e}`),
            ),
          );
        }
      }
    await Promise.all(jobs);
  }

  private async reply(phoneNumberId: string, from: string, text: string) {
    const [link] = await this.db
      .select()
      .from(channelLinks)
      .where(and(eq(channelLinks.channel, 'whatsapp'), eq(channelLinks.address, toWaId(from))));
    if (!link) {
      await this.send(
        phoneNumberId,
        from,
        "This number isn't linked to an account yet. Open the app and link it under your name (WhatsApp).",
      );
      return;
    }
    // The person the number belongs to, exactly as if they had signed in.
    const p: Principal = { actor: { kind: 'user', id: link.ownerId, role: 'owner' }, scopes: [] };
    const turn = await this.chat.once(p, {
      messages: [{ role: 'user', content: text }],
      surfaces: ['text'],
      timeZone: link.timeZone,
    });
    // The model says one line; the views its tools showed follow, rendered to words.
    const words = [
      turn.reply,
      ...turn.toolCalls.flatMap((c) => (c.present?.kind === 'text' ? [c.present.text] : [])),
    ]
      .filter((s) => s.trim())
      .join('\n\n');
    await this.send(phoneNumberId, from, words || 'Done.');
  }

  /** One text message through the Cloud API (or whaloc in development). */
  async send(phoneNumberId: string, to: string, body: string) {
    const { apiBaseUrl, graphVersion, token } = config.whatsapp;
    const res = await fetch(`${apiBaseUrl}/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: body.slice(0, 4096) },
      }),
    });
    if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  }

  /** The person's link, if any. */
  async linkOf(userId: string) {
    const [link] = await this.db
      .select({ address: channelLinks.address, timeZone: channelLinks.timeZone })
      .from(channelLinks)
      .where(and(eq(channelLinks.channel, 'whatsapp'), eq(channelLinks.ownerId, userId)));
    return link ?? null;
  }

  /** Link (or re-link) a number to the person. A number already linked to someone else is refused. */
  async link(userId: string, phone: string, timeZone: string) {
    const address = toWaId(phone);
    const [taken] = await this.db
      .select({ ownerId: channelLinks.ownerId })
      .from(channelLinks)
      .where(and(eq(channelLinks.channel, 'whatsapp'), eq(channelLinks.address, address)));
    if (taken && taken.ownerId !== userId) return null;
    await this.db
      .insert(channelLinks)
      .values({ ownerId: userId, channel: 'whatsapp', address, timeZone })
      .onConflictDoUpdate({
        target: [channelLinks.channel, channelLinks.ownerId],
        set: { address, timeZone },
      });
    return { address, timeZone };
  }

  async unlink(userId: string) {
    await this.db
      .delete(channelLinks)
      .where(and(eq(channelLinks.channel, 'whatsapp'), eq(channelLinks.ownerId, userId)));
  }
}
