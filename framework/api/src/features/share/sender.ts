import type { ChannelAdapter, OutboundMessage } from '@hykr/channels';
import {
  publicForms,
  type ShareReader,
  type ShareSendChannel,
  type ShareSendDef,
  type ShareSendTarget,
  sendOrderOf,
  shareables,
  sharePath,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  recordEvents,
  type ShareLinkRow,
  systemPrincipal,
  TenantConfigService,
} from '@hykr/core';
import {
  contacts,
  customers,
  type Database,
  shareLinks,
  shareSends,
  user,
  writeAudit,
} from '@hykr/db';
import { langOf, pick, t } from '@hykr/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Contact, ContactsService } from '../../channels/contacts.service.js';
import { MailerService } from '../../channels/notify/mailer.service.js';
import { OutboundService } from '../../channels/outbound.service.js';
import { TemplateSync } from '../../channels/templates/template-sync.js';
import { WHATSAPP } from '../../channels/whatsapp/adapter.provider.js';
import { config } from '../../config.js';
import { secretBox } from '../integrations/settings.js';
import { verifiedOriginOf } from '../settings/domains.js';
import { ShareEvent, type ShareSendRow, sendAad } from './ops.js';

const log = new Logger('Share');

/** One try of a send's job: the job's id (the same on each retry), and whether it is the last. */
export interface SendTry {
  by: string;
  lastTry: boolean;
}

/** Who a send reaches, on each channel, and how they read. */
interface Target {
  contact?: Contact;
  email?: string;
  reader: ShareReader;
}

/** Everything a send's words need: the link, its declaration, its target and its address. */
interface Prepared {
  link: ShareLinkRow;
  send: ShareSendDef | undefined;
  target: ShareSendTarget;
  /** `/share/<token>` on the business's verified domain, else APP_URL. */
  url: string;
  token: string;
}

/** A claim older than this is stale (its job is gone): another job finishes it. */
const SENDING_LEASE_MS = 5 * 60_000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Sends share links, in the worker (the share.send queue), at most once (decisions B23): by
 * WhatsApp (the declaration's approved template, its URL button carrying the token; else a plain
 * message inside the 24-hour window) or by email, through the channel's own services: consent,
 * template approval, the outbound queue, the mailer. The token waits sealed on the send and is
 * wiped when it finishes; the message log keeps `[link]` in its place.
 */
@Injectable()
export class ShareSender {
  private readonly db: Database;
  private readonly templates: TemplateSync;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(WHATSAPP) wa: ChannelAdapter,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {
    this.db = core.db;
    this.templates = new TemplateSync(this.db, wa, config.appUrl);
  }

  private service<T>(token: new (...args: never[]) => T): T {
    return this.ref.get(token, { strict: false });
  }

  /** Deliver one send, at most once: claimed by one job, then the first channel that takes it. */
  async send(sendId: string, t: SendTry): Promise<string> {
    const [send] = await this.db.select().from(shareSends).where(eq(shareSends.id, sendId));
    if (!send) return 'no such send';
    if (send.status === 'sent' || send.status === 'failed') return `already ${send.status}`;
    if (send.status === 'sending') return this.resume(send, t);
    const claimed = await this.claim(send.id, t.by);
    if (!claimed) return 'claimed by another job';
    return this.deliver(claimed, t);
  }

  /** Take a queued send, in one statement: of two jobs at once, one gets it. */
  private async claim(id: string, by: string): Promise<ShareSendRow | undefined> {
    const [claimed] = await this.db
      .update(shareSends)
      .set({ status: 'sending', claimedBy: by, claimedAt: new Date() })
      .where(and(eq(shareSends.id, id), inArray(shareSends.status, ['queued', 'waiting'])))
      .returning();
    return claimed;
  }

  /** Let a claim go (nothing left yet): a retry may claim it again. */
  private async release(send: ShareSendRow, by: string) {
    await this.db
      .update(shareSends)
      .set({ status: 'queued', claimedBy: null, claimedAt: null })
      .where(
        and(
          eq(shareSends.id, send.id),
          eq(shareSends.status, 'sending'),
          eq(shareSends.claimedBy, by),
        ),
      );
  }

  /**
   * A send found `sending`: another job's fresh claim is that job's to finish. A later try of the
   * job that claimed it, or a stale claim, is finished from what is recorded: sent when a channel
   * took it, else failed `interrupted` (it may or may not have gone; it is never sent twice).
   */
  private async resume(send: ShareSendRow, t: SendTry): Promise<string> {
    const stale = !send.claimedAt || Date.now() - send.claimedAt.getTime() > SENDING_LEASE_MS;
    if (send.claimedBy !== t.by && !stale) return 'claimed by another job';
    const by = send.claimedBy;
    if (send.address && send.channel)
      return this.finish(
        send,
        'sent',
        { channel: send.channel, address: send.address, messageId: send.messageId ?? undefined },
        by,
      );
    log.warn(`share send ${send.id} stopped while sending: failed, interrupted (never sent twice)`);
    return this.finish(send, 'failed', { error: 'interrupted' }, by);
  }

  /** The link, its words and its address, or why it cannot go. */
  private async prepare(send: ShareSendRow): Promise<Prepared | { error: string }> {
    const [link] = await this.db.select().from(shareLinks).where(eq(shareLinks.id, send.linkId));
    if (!link) return { error: 'link_gone' };
    if (link.revokedAt) return { error: 'link_revoked' };
    if (link.expiresAt && link.expiresAt <= new Date()) return { error: 'link_expired' };
    const box = secretBox();
    let token: string | undefined;
    try {
      token = send.tokenSealed
        ? box?.open(send.tokenSealed, sendAad(send.tenantId, send.id))
        : undefined;
    } catch {
      token = undefined;
    }
    if (!token) return { error: 'token_unavailable' };
    const { name, settings } = await this.service(TenantConfigService).get(link.tenantId);
    const business = { name: settings.branding.name ?? name };
    const form = link.kind === 'form' && link.form ? publicForms.get(link.form) : undefined;
    const shareable =
      link.kind === 'record' && link.resourceType ? shareables.get(link.resourceType) : undefined;
    let record: Record<string, unknown> | undefined;
    if (link.kind === 'record' && link.resourceType && link.resourceId) {
      const def = entityDef(link.resourceType);
      try {
        record = def
          ? ((await def.repo.find(
              this.db,
              systemPrincipal({ tenantId: link.tenantId, job: 'share.send' }),
              link.resourceId,
            )) as Record<string, unknown> | undefined)
          : undefined;
      } catch {
        record = undefined;
      }
      if (!record) return { error: 'record_gone' };
    }
    const origin = (await verifiedOriginOf(this.db, link.tenantId)) ?? config.appUrl;
    return {
      link,
      send: form?.send ?? shareable?.send,
      token,
      url: `${origin}${sharePath(token)}`,
      target: {
        kind: link.kind,
        label: '',
        ...(record ? { record } : {}),
        ...(form ? { form: form.name } : {}),
        business,
      },
    };
  }

  /** The link's words in the reader's language: its label, else the record's or form's. */
  private labelFor(p: Prepared, lang: ShareReader['lang']): string {
    if (p.link.label) return p.link.label;
    if (p.link.kind === 'form' && p.link.form) {
      const form = publicForms.get(p.link.form);
      return form ? pick(form.label, lang) : p.link.form;
    }
    const def = p.link.resourceType ? entityDef(p.link.resourceType) : undefined;
    const r = p.target.record;
    const title = r ? (r.title ?? r.name ?? r.number) : undefined;
    const what = def?.spec.label ?? 'a page';
    return typeof title === 'string' && title.trim() ? `${what} ${title.trim()}` : what;
  }

  /** Who the recipient is on each channel, and how they read. */
  private async target(send: ShareSendRow, timeZone: string): Promise<Target> {
    const to = send.recipient;
    let contact: Contact | undefined;
    let userId: string | null | undefined;
    let email: string | undefined;
    if (to.customerId) {
      const [c] = await this.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, to.customerId), eq(customers.tenantId, send.tenantId)));
      [contact] = c
        ? await this.db
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, send.tenantId),
                c.contactId ? eq(contacts.id, c.contactId) : eq(contacts.customerId, c.id),
              ),
            )
            .limit(1)
        : [];
      userId = c?.userId;
    } else if (to.contactId) {
      [contact] = await this.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, to.contactId), eq(contacts.tenantId, send.tenantId)));
      userId = contact?.userId;
    } else if (to.email) email = to.email;
    if (userId && !email) {
      const [person] = await this.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId));
      email = person?.email;
    }
    return {
      contact,
      email,
      reader: {
        lang: langOf(contact?.locale ?? undefined),
        timeZone: contact?.timeZone ?? timeZone,
      },
    };
  }

  /**
   * By WhatsApp: the declaration's template when approved (its URL button carries the token),
   * else a plain message inside the 24-hour window. Undefined when WhatsApp cannot take it.
   */
  private async viaWhatsApp(p: Prepared, to: Target) {
    const contact = to.contact;
    if (!contact || contact.unreachableAt) return undefined;
    const channel = this.service(ContactsService);
    if (!(await channel.consent(contact.id, 'service'))) return undefined;
    const from = await channel.numberOfTenant(p.link.tenantId);
    if (!from) return undefined;
    const how = p.send?.whatsapp;
    const lang = how
      ? (await this.templates.approved(how.template.name, to.reader.lang))
        ? to.reader.lang
        : (await this.templates.approved(how.template.name, 'en'))
          ? 'en'
          : undefined
      : undefined;
    let message: OutboundMessage;
    if (how && lang) {
      const reader = { ...to.reader, lang };
      const target = { ...p.target, label: this.labelFor(p, lang) };
      message = {
        kind: 'template',
        to: contact.address,
        name: how.template.name,
        language: lang,
        params: how.params(target, reader),
        // The template's URL button is `/share/{{1}}` on APP_URL: its parameter is the token.
        buttons: (how.template.buttons ?? []).map((b) =>
          b.type === 'url' ? { urlParam: p.token } : { payload: 'share' },
        ),
        sensitive: [p.token],
      };
    } else {
      if (!(await channel.windowOpen(contact.id))) return undefined;
      message = {
        kind: 'text',
        to: contact.address,
        text: t(to.reader.lang, 'share.send.text', {
          business: p.target.business.name,
          label: this.labelFor(p, to.reader.lang),
          url: p.url,
        }),
        sensitive: [p.token],
      };
    }
    const [messageId] = await this.service(OutboundService).queue(
      { tenantId: p.link.tenantId, contactId: contact.id, from },
      [message],
      { category: how?.template.category ?? 'utility' },
    );
    return { address: contact.address, messageId };
  }

  /** By email: the declaration's words, or the framework's. Undefined without an address. */
  private async viaEmail(p: Prepared, send: ShareSendRow, to: Target) {
    if (!to.email) return undefined;
    const lang = to.reader.lang;
    const target = { ...p.target, label: this.labelFor(p, lang) };
    const how = p.send?.email;
    const vars = { business: target.business.name, label: target.label, url: p.url };
    const messageId = await this.service(MailerService).send(
      { email: to.email, tenantId: p.link.tenantId, contactId: to.contact?.id },
      {
        subject: how ? how.subject(target, to.reader) : t(lang, 'share.send.subject', vars),
        text: how ? how.body(target, to.reader, p.url) : t(lang, 'share.send.body', vars),
      },
      { extra: { shareLink: p.link.id, send: send.id }, sensitive: [p.token] },
    );
    return { address: to.email, messageId };
  }

  /** Deliver a send this job has claimed. */
  private async deliver(send: ShareSendRow, t: SendTry): Promise<string> {
    let gone: { channel: ShareSendChannel; address: string; messageId: string } | undefined;
    try {
      const p = await this.prepare(send);
      if ('error' in p) return await this.finish(send, 'failed', { error: p.error }, t.by);
      const { settings } = await this.service(TenantConfigService).get(send.tenantId);
      const to = await this.target(send, settings.timeZone ?? config.defaultTimeZone ?? 'UTC');
      const order: ShareSendChannel[] = send.channel ? [send.channel] : sendOrderOf(p.send);
      for (const channel of order) {
        const done =
          channel === 'whatsapp' ? await this.viaWhatsApp(p, to) : await this.viaEmail(p, send, to);
        if (done) {
          gone = { channel, ...done };
          break;
        }
      }
      if (!gone) return await this.finish(send, 'failed', { error: 'unreachable' }, t.by);
      // It left: written first, so a try after a failure from here on finishes it, never resends.
      await this.db
        .update(shareSends)
        .set({ channel: gone.channel, address: gone.address, messageId: gone.messageId })
        .where(
          and(
            eq(shareSends.id, send.id),
            eq(shareSends.status, 'sending'),
            eq(shareSends.claimedBy, t.by),
          ),
        );
      return await this.finish(send, 'sent', gone, t.by);
    } catch (e) {
      if (gone) throw e;
      if (!t.lastTry) {
        await this.release(send, t.by);
        throw e;
      }
      log.error(`share send ${send.id} failed: ${messageOf(e)}`);
      return this.finish(send, 'failed', { error: messageOf(e) }, t.by);
    }
  }

  /**
   * A send's outcome: recorded once, its sealed token wiped, audited and stored as an event (ids
   * and states only). A claimed send is finished only by the job that holds the claim.
   */
  private async finish(
    send: ShareSendRow,
    status: 'sent' | 'failed',
    a: { channel?: ShareSendChannel; address?: string; messageId?: string; error?: string },
    claimedBy?: string | null,
  ): Promise<string> {
    const recorded = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(shareSends)
        .set({
          status,
          ...(a.channel ? { channel: a.channel } : {}),
          address: a.address ?? null,
          messageId: a.messageId ?? null,
          error: a.error ?? null,
          tokenSealed: null,
          ...(status === 'sent' ? { sentAt: sql`now()` } : {}),
        })
        .where(
          and(
            eq(shareSends.id, send.id),
            claimedBy === undefined
              ? inArray(shareSends.status, ['queued', 'waiting'])
              : and(
                  eq(shareSends.status, 'sending'),
                  claimedBy === null
                    ? isNull(shareSends.claimedBy)
                    : eq(shareSends.claimedBy, claimedBy),
                ),
          ),
        )
        .returning();
      if (!done) return false;
      await writeAudit(tx, {
        action: status === 'sent' ? 'share.sent' : 'share.send_failed',
        resourceType: 'shareLink',
        resourceId: send.linkId,
        actorKind: 'system',
        actorId: 'share.send',
        tenantId: send.tenantId,
        channel: 'background',
        after: {
          send: send.id,
          to: send.recipient,
          channel: done.channel,
          ...(done.error ? { error: done.error } : {}),
        },
      });
      await recordEvents(tx, {
        principal: systemPrincipal({ tenantId: send.tenantId, job: 'share.send' }),
        events: [
          new ShareEvent(status === 'sent' ? 'share.sent' : 'share.send_failed', {
            id: done.id,
            tenantId: done.tenantId,
            linkId: done.linkId,
            channel: done.channel,
            status: done.status,
          }),
        ],
      });
      return true;
    });
    if (!recorded) return 'finished by another job';
    return status === 'sent' ? `sent by ${a.channel}` : `failed: ${a.error}`;
  }
}
